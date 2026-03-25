/**
 * Obsidian/SecondBrain writer tool for Claude Agent SDK.
 *
 * Wraps ApiScripts/secondbrain-writer.mjs to save content as
 * Obsidian notes. Claude can save articles, video summaries,
 * email digests — anything — to the knowledge base.
 */
import { execSync } from "node:child_process";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const APISCRIPTS_DIR =
  process.env.APISCRIPTS_DIR ??
  "/storage/emulated/0/Documents/Code/ApiScripts";

function log(msg: string) {
  process.stderr.write(`[obsidian] ${msg}\n`);
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
      .enum(["YouTube", "Substack", "Medium", "Gmail", "HackerNews", "Manual"])
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
    const payload = {
      title: args.title,
      body: args.body,
      source: args.source,
      ...(args.author ? { author: args.author } : {}),
      ...(args.url ? { url: args.url } : {}),
      tags: args.tags,
      ...(args.folder ? { folder: args.folder } : {}),
    };

    log(`Saving note: "${args.title}" (source: ${args.source})`);

    try {
      const result = execSync(
        `echo '${JSON.stringify(payload).replace(/'/g, "'\\''")}' | node secondbrain-writer.mjs`,
        {
          encoding: "utf-8",
          cwd: APISCRIPTS_DIR,
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      log(`Saved: ${result.trim()}`);
      return {
        content: [{
          type: "text" as const,
          text: `Note saved to SecondBrain: "${args.title}"\n${result.trim()}`,
        }],
      };
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? "";
      log(`Failed: ${stderr || err.message}`);
      return {
        content: [{ type: "text" as const, text: `Failed to save note: ${stderr || err.message}` }],
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
