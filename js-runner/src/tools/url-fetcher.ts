/**
 * URL Fetcher tool for Claude Agent SDK.
 *
 * Accepts any URL, classifies it, and fetches content:
 * - YouTube → metadata via YouTube Data API (ApiScripts) + transcript via yt-dlp
 * - Articles → Jina Reader (r.jina.ai)
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APISCRIPTS_DIR =
  process.env.APISCRIPTS_DIR ??
  "/storage/emulated/0/Documents/Code/ApiScripts";

const CLASSIFY_RULES = [
  { type: "video", patterns: ["youtube.com/watch", "youtube.com/live", "youtu.be/", "m.youtube.com/watch"] },
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
  return "article";
}

function log(msg: string) {
  process.stderr.write(`[url_fetcher] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// YouTube — metadata via ApiScripts + transcript via yt-dlp
// ---------------------------------------------------------------------------

let _parseVideoId: ((input: string) => string) | null = null;
let _getVideoInfo: ((videoId: string) => Promise<any>) | null = null;

async function loadYouTubeModule() {
  if (!_parseVideoId) {
    const mod = await import(`${APISCRIPTS_DIR}/youtube/get-video.mjs`);
    _parseVideoId = mod.parseVideoId;
    _getVideoInfo = mod.getVideoInfo;
  }
  return { parseVideoId: _parseVideoId!, getVideoInfo: _getVideoInfo! };
}

async function fetchYouTubeTranscript(url: string): Promise<string | null> {
  const { execSync } = await import("node:child_process");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { dirname, basename } = await import("node:path");

  const tmpDir = process.env.TMPDIR ?? "/data/data/com.termux/files/usr/tmp";
  const tmpBase = `${tmpDir}/yt-sub-${Date.now()}`;

  log(`Downloading transcript via yt-dlp: ${url}`);
  try {
    execSync(
      `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format srt -o "${tmpBase}" "${url}"`,
      {
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, TMPDIR: tmpDir },
      }
    );

    const dir = dirname(tmpBase);
    const prefix = basename(tmpBase);
    const srtFile = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".srt"))
      .map((f) => `${dir}/${f}`)[0];

    if (!srtFile) {
      log("No subtitle file found");
      return null;
    }

    log(`Found subtitle: ${srtFile}`);
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
    log(`Transcript done: ${text.length} chars`);
    return text.trim().length > 100 ? text.trim() : null;
  } catch (err: any) {
    log(`yt-dlp failed: ${err.message?.slice(0, 200) ?? "unknown"}`);
    try { execSync(`rm -f "${tmpBase}"* 2>/dev/null`); } catch {}
    return null;
  }
}

async function fetchYouTube(url: string): Promise<string> {
  const { parseVideoId, getVideoInfo } = await loadYouTubeModule();
  const videoId = parseVideoId(url);

  // 1. Metadata via YouTube Data API
  log(`Fetching video metadata: ${videoId}`);
  let metaBlock = "";
  try {
    const video = await getVideoInfo(videoId);
    if (video) {
      const { snippet, contentDetails, statistics } = video;
      metaBlock = [
        `Title: ${snippet.title}`,
        `Channel: ${snippet.channelTitle}`,
        `Published: ${new Date(snippet.publishedAt).toLocaleDateString()}`,
        `Duration: ${contentDetails.duration}`,
        `Views: ${Number(statistics.viewCount).toLocaleString()}`,
        `Likes: ${Number(statistics.likeCount).toLocaleString()}`,
        ``,
        `Description:`,
        snippet.description.slice(0, 500),
      ].join("\n");
      log(`Metadata OK: "${snippet.title}"`);
    }
  } catch (err: any) {
    log(`YouTube API metadata failed: ${err.message?.slice(0, 100) ?? "unknown"}`);
  }

  // 2. Transcript via yt-dlp
  const transcript = await fetchYouTubeTranscript(url);

  // Combine
  const parts: string[] = [];
  if (metaBlock) parts.push(metaBlock);
  if (transcript) {
    parts.push("\n--- Transcript ---\n");
    parts.push(transcript);
  }

  if (parts.length === 0) {
    throw new Error(`Could not fetch video metadata or transcript for ${url}`);
  }

  if (!transcript && metaBlock) {
    parts.push("\n(Transcript not available — yt-dlp failed or no subtitles found)");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Articles — Jina Reader
// ---------------------------------------------------------------------------

async function fetchArticle(url: string): Promise<string> {
  log(`Fetching article via Jina Reader: ${url}`);
  const jinaUrl = `https://r.jina.ai/${url}`;
  const res = await fetch(jinaUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/plain" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jina fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  log(`Article done: ${text.length} chars`);
  return text;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function fetchContent(url: string, type: string): Promise<string> {
  if (type === "video") return fetchYouTube(url);
  return fetchArticle(url);
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const fetchUrl = tool(
  "fetch_url",
  "Fetch and extract content from any URL. Automatically detects the type: YouTube videos get metadata (title, channel, views) via YouTube API plus transcript via yt-dlp. Articles, blogs, Substack, Medium get clean markdown via Jina Reader. Returns the full text content.",
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
