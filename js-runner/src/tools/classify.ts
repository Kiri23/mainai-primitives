/**
 * Content Classifier tool for the pipeline agent.
 *
 * Pure pattern matching — no Claude calls, no MemoryGraph.
 * Expands on url-fetcher's classifyUrl() with support for:
 * - URLs (YouTube, Substack, Medium, GitHub, LinkedIn, etc.)
 * - Gmail message IDs
 * - Free text with author/title
 * - Notification text (from notif-daemon)
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

const URL_RULES: { type: string; source: string; patterns: string[] }[] = [
  { type: "video", source: "YouTube", patterns: ["youtube.com/watch", "youtube.com/live", "youtu.be/", "m.youtube.com/watch"] },
  { type: "channel", source: "YouTube", patterns: ["youtube.com/@", "youtube.com/channel/"] },
  { type: "newsletter", source: "Substack", patterns: [".substack.com/p/"] },
  { type: "article", source: "Medium", patterns: ["medium.com/", ".medium.com/"] },
  { type: "repo", source: "GitHub", patterns: ["github.com/"] },
  { type: "job-offer", source: "LinkedIn", patterns: ["linkedin.com/jobs/", "linkedin.com/comm/jobs/"] },
  { type: "article", source: "HackerNews", patterns: ["news.ycombinator.com"] },
  { type: "article", source: "Reddit", patterns: ["reddit.com/r/"] },
  { type: "article", source: "Web", patterns: ["/blog/", "/posts/", "/article/"] },
  { type: "skip", source: "Web", patterns: ["/privacy", "/terms", "/legal", "/unsubscribe"] },
];

// Keywords that hint at content type from notification text
const TYPE_KEYWORDS: Record<string, string[]> = {
  video: ["video", "watch", "stream", "live", "episode", "ep."],
  newsletter: ["newsletter", "digest", "weekly", "issue #", "edition"],
  article: ["article", "blog", "post", "wrote", "published", "read"],
  podcast: ["podcast", "listen", "episode"],
};

// ---------------------------------------------------------------------------
// Sender Profile lookup
// ---------------------------------------------------------------------------

const SENDER_PROFILES_DIR =
  "/storage/emulated/0/Documents/Secondbrain/Resources/Sender Profiles";

function checkSenderProfile(author: string): { exists: boolean; filename?: string } {
  if (!author || author === "unknown") return { exists: false };
  try {
    if (!existsSync(SENDER_PROFILES_DIR)) return { exists: false };
    const files = readdirSync(SENDER_PROFILES_DIR);
    const match = files.find(
      (f) => f.toLowerCase().replace(".md", "") === author.toLowerCase()
    );
    return match ? { exists: true, filename: match } : { exists: false };
  } catch {
    return { exists: false };
  }
}

// ---------------------------------------------------------------------------
// Extract URL from text
// ---------------------------------------------------------------------------

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)>\]]+/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

interface Classification {
  type: string;
  source: string;
  title: string;
  author: string;
  url: string | null;
  senderProfile: { exists: boolean; filename?: string };
  inputKind: "url" | "gmail-id" | "notification" | "text";
}

function classify(input: string): Classification {
  const trimmed = input.trim();

  // 1. URL input
  const url = extractUrl(trimmed);
  if (url) {
    const lower = url.toLowerCase();
    for (const rule of URL_RULES) {
      if (rule.patterns.some((p) => lower.includes(p))) {
        const author = extractAuthorFromUrl(url);
        return {
          type: rule.type,
          source: rule.source,
          title: extractTitleFromUrl(url),
          author,
          url,
          senderProfile: checkSenderProfile(author),
          inputKind: "url",
        };
      }
    }
    return {
      type: "article",
      source: "Web",
      title: extractTitleFromUrl(url),
      author: "unknown",
      url,
      senderProfile: { exists: false },
      inputKind: "url",
    };
  }

  // 2. Gmail ID (no spaces, alphanumeric, 10+ chars)
  if (/^[a-zA-Z0-9]{10,}$/.test(trimmed)) {
    return {
      type: "email",
      source: "Gmail",
      title: "unknown",
      author: "unknown",
      url: null,
      senderProfile: { exists: false },
      inputKind: "gmail-id",
    };
  }

  // 3. Notification text or free text
  const author = extractAuthorFromText(trimmed);
  const type = inferTypeFromText(trimmed);
  return {
    type,
    source: inferSourceFromText(trimmed),
    title: trimmed.split("\n")[0].slice(0, 100),
    author,
    url: null,
    senderProfile: checkSenderProfile(author),
    inputKind: trimmed.includes("·") ? "notification" : "text",
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractAuthorFromUrl(url: string): string {
  // YouTube: extract @handle or channel name
  const ytHandle = url.match(/youtube\.com\/@([^/?\s]+)/);
  if (ytHandle) return ytHandle[1];

  // Substack: subdomain is the author
  const substack = url.match(/https?:\/\/([^.]+)\.substack\.com/);
  if (substack) return substack[1];

  // Medium: first path segment after medium.com
  const medium = url.match(/medium\.com\/@?([^/?\s]+)/);
  if (medium) return medium[1];

  // Reddit: subreddit as source
  const reddit = url.match(/reddit\.com\/r\/([^/?\s]+)/);
  if (reddit) return `r/${reddit[1]}`;

  // GitHub: owner/repo
  const gh = url.match(/github\.com\/([^/?\s]+\/[^/?\s]+)/);
  if (gh) return gh[1];

  return "unknown";
}

function extractTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    return slug
      .replace(/[-_]/g, " ")
      .replace(/\.[^.]+$/, "")
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
      || "unknown";
  } catch {
    return "unknown";
  }
}

function extractAuthorFromText(text: string): string {
  // "Title" by Author
  const byMatch = text.match(/by\s+([^()\n]+)/i);
  if (byMatch) return byMatch[1].trim();

  // Author — Title or Author: Title
  const dashMatch = text.match(/^([^—:\n]+?)\s*[—:]\s/);
  if (dashMatch && dashMatch[1].length < 40) return dashMatch[1].trim();

  return "unknown";
}

function inferTypeFromText(text: string): string {
  const lower = text.toLowerCase();
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return type;
  }
  return "article";
}

function inferSourceFromText(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("youtube") || lower.includes("yt")) return "YouTube";
  if (lower.includes("substack")) return "Substack";
  if (lower.includes("medium")) return "Medium";
  if (lower.includes("reddit") || lower.includes("r/")) return "Reddit";
  if (lower.includes("linkedin")) return "LinkedIn";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Agent SDK Tool
// ---------------------------------------------------------------------------

const classifyContent = tool(
  "classify_content",
  "Classify a URL, Gmail ID, notification text, or free text into a content type (video, article, newsletter, email, repo, job-offer). Returns structured classification with type, source, author, sender profile status. Pure pattern matching — instant, no API calls.",
  {
    input: z.string().describe("URL, Gmail message ID, notification text, or descriptive text to classify"),
  },
  async (args) => {
    const result = classify(args.input);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
  { annotations: { readOnlyHint: true } }
);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const classifyServer = createSdkMcpServer({
  name: "classify",
  version: "1.0.0",
  tools: [classifyContent],
});
