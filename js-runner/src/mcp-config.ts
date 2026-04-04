/**
 * MainAI MCP configuration — single source of truth.
 *
 * Every surface (CLI, web, Telegram) imports this instead of
 * duplicating server URLs and tool lists.
 */
import { gmailServer } from "./tools/gmail.ts";
import { urlFetcherServer } from "./tools/url-fetcher.ts";
import { obsidianServer } from "./tools/obsidian.ts";
import { classifyServer } from "./tools/classify.ts";

const MEMORYGRAPH_URL =
  process.env.MEMORYGRAPH_URL ?? "https://vps.tailc0560d.ts.net/sse";

/** All MCP servers that make up MainAI */
export function getMcpServers() {
  return {
    gmail: gmailServer,
    url_fetcher: urlFetcherServer,
    obsidian: obsidianServer,
    classify: classifyServer,
    memorygraph: { type: "sse" as const, url: MEMORYGRAPH_URL },
  };
}

/** AllowedTools pattern for all MCP servers */
export function getAllowedTools() {
  return Object.keys(getMcpServers()).map((k) => `mcp__${k}__*`);
}
