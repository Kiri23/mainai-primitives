/**
 * Obsidian/SecondBrain writer tool for Claude Agent SDK.
 *
 * Saves content as Obsidian notes. Works in two modes:
 * - Local (Termux): uses secondbrain-writer.mjs via ApiScripts
 * - Remote (VPS): writes markdown directly to SECONDBRAIN_PATH
 *
 * The tool auto-detects which mode to use based on whether
 * the ApiScripts writer exists.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const APISCRIPTS_DIR =
  process.env.APISCRIPTS_DIR ??
  "/storage/emulated/0/Documents/Code/ApiScripts";

const WRITER_SCRIPT = join(APISCRIPTS_DIR, "secondbrain-writer.mjs");

const SECONDBRAIN_PATH =
  process.env.SECONDBRAIN_PATH ??
  `${process.env.HOME}/storage/documents/Secondbrain`;

const RESOURCES_DIR = join(SECONDBRAIN_PATH, "Resources");

const FOLDER_MAP: Record<string, string> = {
  youtube: "Channels",
  substack: "Industry News",
  medium: "Industry News",
  gmail: "Industry News",
  reddit: "Industry News",
  hackernews: "Industry News",
  manual: "",
};

function log(msg: string) {
  process.stderr.write(`[obsidian] ${msg}\n`);
}

function sanitizeFilename(name: string): string {
  return (name || "Untitled")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

function resolveFolder(source: string, folder?: string): string {
  if (folder) return join(RESOURCES_DIR, folder);
  const mapped = FOLDER_MAP[source.toLowerCase()];
  if (mapped !== undefined) return mapped ? join(RESOURCES_DIR, mapped) : RESOURCES_DIR;
  return join(RESOURCES_DIR, "Industry News");
}

function buildNote(args: {
  title: string;
  body: string;
  source: string;
  author?: string;
  url?: string;
  tags: string[];
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const tagLine = args.tags.length > 0
    ? args.tags.map((t) => `  - ${t}`).join("\n")
    : "  - untagged";

  return `---
title: "${args.title.replace(/"/g, '\\"')}"
source: ${args.source}
author: ${args.author || "unknown"}
date: ${date}
url: ${args.url || ""}
reviewed: no
tags:
${tagLine}
---

${args.body}
`;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const saveToObsidian = tool(
  "save_to_obsidian",
  "Save content as an Obsidian note in Christian's SecondBrain knowledge base. Use this to save article summaries, video transcripts, email digests, research notes, or any content worth keeping. The note is created with proper frontmatter, tags, and filed into the right folder automatically based on source type.",
  {
    title: z.string().describe("Note title"),
    body: z.string().describe("The main content to save (markdown)"),
    source: z
      .enum(["YouTube", "Substack", "Medium", "Gmail", "HackerNews", "Reddit", "Manual"])
      .default("Manual")
      .describe("Where the content came from — determines which folder it goes to"),
    author: z.string().optional().describe("Author or channel name"),
    url: z.string().optional().describe("Original URL of the content"),
    tags: z
      .array(z.string())
      .default([])
      .describe("Tags for the note (e.g. ['ai-agents', 'nvidia', 'enterprise'])"),
    folder: z
      .string()
      .optional()
      .describe("Override folder under Resources/ (e.g. 'Channels/Fireship')"),
  },
  async (args) => {
    log(`Saving note: "${args.title}" (source: ${args.source})`);

    // Mode 1: Use secondbrain-writer.mjs if available (Termux/local)
    if (existsSync(WRITER_SCRIPT)) {
      try {
        const payload = {
          title: args.title,
          body: args.body,
          source: args.source,
          ...(args.author ? { author: args.author } : {}),
          ...(args.url ? { url: args.url } : {}),
          tags: args.tags,
          ...(args.folder ? { folder: args.folder } : {}),
        };
        const result = execSync(`node secondbrain-writer.mjs`, {
          input: JSON.stringify(payload),
          encoding: "utf-8",
          cwd: APISCRIPTS_DIR,
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        log(`Saved via writer: ${result.trim()}`);
        return {
          content: [{ type: "text" as const, text: `Note saved: "${args.title}"\n${result.trim()}` }],
        };
      } catch (err: any) {
        log(`Writer failed, falling back to direct write: ${err.message}`);
      }
    }

    // Mode 2: Write markdown directly (VPS/remote)
    try {
      const folder = resolveFolder(args.source, args.folder);
      mkdirSync(folder, { recursive: true });

      const filename = `${sanitizeFilename(args.title)}.md`;
      const filepath = join(folder, filename);
      const note = buildNote(args);

      writeFileSync(filepath, note, "utf-8");
      log(`Saved directly: ${filepath}`);

      return {
        content: [{ type: "text" as const, text: `Note saved: "${args.title}"\nPath: ${filepath}` }],
      };
    } catch (err: any) {
      log(`Direct write failed: ${err.message}`);
      return {
        content: [{ type: "text" as const, text: `Failed to save note: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const obsidianServer = createSdkMcpServer({
  name: "obsidian",
  version: "1.0.0",
  tools: [saveToObsidian],
});
