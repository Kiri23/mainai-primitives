/**
 * Gmail tools for Claude Agent SDK.
 *
 * Wraps ApiScripts gmail/search.mjs and gmail/get.mjs as custom tools
 * via direct import — reuses Google OAuth auth and avoids subprocess overhead.
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Dynamic imports — ApiScripts are .mjs, we load them at runtime
// ---------------------------------------------------------------------------

const APISCRIPTS_DIR =
  process.env.APISCRIPTS_DIR ??
  "/storage/emulated/0/Documents/Code/ApiScripts";

let _searchEmails: ((query: string, opts?: { limit?: number }) => Promise<any[]>) | null = null;
let _getMessage: ((id: string) => Promise<any>) | null = null;
let _extractBody: ((msg: any) => string) | null = null;
let _extractHeader: ((msg: any, name: string) => string) | null = null;

async function loadGmailModules() {
  if (!_searchEmails) {
    const search = await import(`${APISCRIPTS_DIR}/gmail/search.mjs`);
    const get = await import(`${APISCRIPTS_DIR}/gmail/get.mjs`);
    const lib = await import(`${APISCRIPTS_DIR}/gmail/_lib.mjs`);
    _searchEmails = search.searchEmails;
    _getMessage = get.getMessage;
    _extractBody = lib.extractBody;
    _extractHeader = lib.extractHeader;
  }
  return {
    searchEmails: _searchEmails!,
    getMessage: _getMessage!,
    extractBody: _extractBody!,
    extractHeader: _extractHeader!,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchGmail = tool(
  "search_gmail",
  "Search Christian's Gmail inbox. Uses Gmail query syntax: from:, subject:, newer_than:, is:unread, has:attachment, in:promotions, label:, etc. Returns subject, sender, date, snippet, and message ID for each result.",
  {
    query: z.string().describe(
      "Gmail search query (e.g. 'from:nate newer_than:1d', 'subject:invoice', 'is:unread')"
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of emails to return"),
  },
  async (args) => {
    const { searchEmails } = await loadGmailModules();
    const emails = await searchEmails(args.query, { limit: args.limit });

    const summary = emails
      .map(
        (e: any, i: number) =>
          `${i + 1}. ${e.subject}\n   From: ${e.from}\n   Date: ${e.date}\n   ID: ${e.id}\n   Snippet: ${e.snippet ?? ""}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: emails.length > 0
            ? `Found ${emails.length} emails:\n\n${summary}`
            : "No emails found for that query.",
        },
      ],
    };
  },
  { annotations: { readOnlyHint: true } }
);

const readEmail = tool(
  "read_email",
  "Read the full content of a specific email by its message ID. Use search_gmail first to find the ID, then read_email to get the full body.",
  {
    messageId: z.string().describe("Gmail message ID (from search_gmail results)"),
  },
  async (args) => {
    const { getMessage, extractBody, extractHeader } = await loadGmailModules();
    const msg = await getMessage(args.messageId);

    const from = extractHeader(msg, "From");
    const subject = extractHeader(msg, "Subject");
    const date = extractHeader(msg, "Date");
    const body = extractBody(msg);

    const formatted = [
      `Subject: ${subject}`,
      `From: ${from}`,
      `Date: ${date}`,
      `ID: ${msg.id}`,
      "",
      "--- Body ---",
      body,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
  { annotations: { readOnlyHint: true } }
);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const gmailServer = createSdkMcpServer({
  name: "gmail",
  version: "1.0.0",
  tools: [searchGmail, readEmail],
});
