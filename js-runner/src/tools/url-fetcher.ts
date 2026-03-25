/**
 * URL Fetcher tool for Claude Agent SDK.
 *
 * Accepts any URL, classifies it (YouTube, article, Substack, Medium, etc.),
 * fetches the content using the right strategy (yt-dlp for video, Jina for articles),
 * and returns the text content to Claude.
 *
 * Reuses classifyUrl + fetchContent from ApiScripts/scrape-links.mjs.
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Dynamic import of scrape-links.mjs
// ---------------------------------------------------------------------------

const APISCRIPTS_DIR =
  process.env.APISCRIPTS_DIR ??
  "/storage/emulated/0/Documents/Code/ApiScripts";

// scrape-links.mjs doesn't export its functions (it's a CLI script),
// so we inline the classification + fetching logic here, matching its patterns.

const CLASSIFY_RULES = [
  { type: "video", patterns: ["youtube.com/watch", "youtube.com/live", "youtu.be/"] },
  { type: "article", patterns: ["medium.com/", "dev.to/", "substack.com/"] },
  { type: "article", patterns: ["/blog/", "/posts/", "/article/"] },
  { type: "article", patterns: ["chatgpt.com/share/"] },
  { type: "forum", patterns: ["community.neo4j.com/t/", "github.com/"] },
  { type: "social", patterns: ["linkedin.com/", "twitter.com/", "bsky.app/"] },
  { type: "skip", patterns: ["/privacy", "/terms", "/legal", "/unsubscribe"] },
];

function classifyUrl(url: string): string {
  const lower = url.toLowerCase();
  for (const rule of CLASSIFY_RULES) {
    if (rule.patterns.some((p) => lower.includes(p))) {
      return rule.type;
    }
  }
  return "article"; // default: try Jina
}

function log(msg: string) {
  process.stderr.write(`[url_fetcher] ${msg}\n`);
}

async function fetchJina(url: string): Promise<string> {
  log(`Fetching via Jina Reader: ${url}`);
  const jinaUrl = `https://r.jina.ai/${url}`;
  const res = await fetch(jinaUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/plain" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jina fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  log(`Jina done: ${text.length} chars`);
  return text;
}

async function fetchYtdlp(url: string): Promise<string> {
  const { execSync, } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const tmpBase = `/tmp/yt-sub-${Date.now()}`;

  log(`Downloading subtitles via yt-dlp: ${url}`);
  try {
    // stderr → inherit so yt-dlp progress shows in terminal
    execSync(
      `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format srt -o "${tmpBase}" "${url}"`,
      { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "inherit"] }
    );
    const srtFile = `${tmpBase}.en.srt`;
    const srt = readFileSync(srtFile, "utf-8");
    const text = srt
      .split("\n")
      .filter(
        (line) =>
          !/^\d+$/.test(line.trim()) &&
          !/^\d{2}:\d{2}/.test(line.trim()) &&
          line.trim()
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    try { execSync(`rm -f "${tmpBase}"*.srt "${tmpBase}"*.vtt 2>/dev/null`); } catch {}
    log(`yt-dlp done: ${text.length} chars`);
    if (text.trim().length > 100) return text.trim();
  } catch (err: any) {
    log(`yt-dlp failed: ${err.message?.slice(0, 200) ?? "unknown"}, falling back to Jina`);
  }
  try {
    const { execSync: exec2 } = await import("node:child_process");
    exec2(`rm -f "${tmpBase}"* 2>/dev/null`);
  } catch {}

  return fetchJina(url);
}

async function fetchContent(url: string, type: string): Promise<string> {
  if (type === "video") return fetchYtdlp(url);
  return fetchJina(url);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const fetchUrl = tool(
  "fetch_url",
  "Fetch and extract content from any URL. Automatically detects the type (YouTube video, article, blog post, Medium, Substack, etc.) and uses the right extraction method: yt-dlp for videos (gets transcript), Jina Reader for articles (gets clean markdown). Returns the full text content.",
  {
    url: z.string().url().describe("The URL to fetch content from"),
  },
  async (args) => {
    const type = classifyUrl(args.url);
    log(`Classified "${args.url}" as: ${type}`);

    if (type === "skip") {
      return {
        content: [{ type: "text" as const, text: `Skipped: URL classified as '${type}' (privacy/terms/unsubscribe page)` }],
      };
    }

    if (type === "social") {
      return {
        content: [{
          type: "text" as const,
          text: `URL is a social media link (${type}). These require authentication and can't be fetched directly. The URL is: ${args.url}`,
        }],
      };
    }

    try {
      const content = await fetchContent(args.url, type);

      // Truncate if massive (avoid blowing context window)
      const maxChars = 15_000;
      const truncated = content.length > maxChars
        ? content.slice(0, maxChars) + `\n\n... [truncated, ${content.length} total chars]`
        : content;

      return {
        content: [{
          type: "text" as const,
          text: `[Type: ${type}] [URL: ${args.url}]\n\n${truncated}`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Failed to fetch: ${err.message}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const urlFetcherServer = createSdkMcpServer({
  name: "url_fetcher",
  version: "1.0.0",
  tools: [fetchUrl],
});
