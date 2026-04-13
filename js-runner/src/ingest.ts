/**
 * Knowledge Graph Ingestion — LLM as preprocessing function f
 *
 * Runs the MainAI agent to fetch content from a source (Gmail, YouTube, etc.),
 * extract entities/topics/urgency via LLM, and output structured JSON.
 *
 * Usage:
 *   npx tsx src/ingest.ts gmail                          # stdout
 *   npx tsx src/ingest.ts gmail --out ./data/gmail.json  # write to file
 *   npx tsx src/ingest.ts gmail --limit 5                # fewer emails
 *   npx tsx src/ingest.ts gmail --query "newer_than:3d"  # custom query
 *
 *   # Notifications (discovery → enrichment via APIs)
 *   npx tsx src/ingest.ts notifications --file ./notifs.json --out ./data/notifs.json
 *   npx tsx src/ingest.ts notifications --file ./notifs.json --apps youtube,reddit,substack
 *
 * The JSON output follows the Knowledge Graph schema:
 *   { source, extracted_at, nodes: Content[], entities: Entity[], topics: Topic[], edges: Edge[] }
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runClaude } from "./claude-runner.ts";
import { getMcpServers, getAllowedTools } from "./mcp-config.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--")) ?? "gmail";
const outIdx = args.indexOf("--out");
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;
const queryIdx = args.indexOf("--query");
const queryFilter = queryIdx !== -1 ? args[queryIdx + 1] : null;
const fileIdx = args.indexOf("--file");
const inputFile = fileIdx !== -1 ? args[fileIdx + 1] : null;
const appsIdx = args.indexOf("--apps");
const appsFilter = appsIdx !== -1 ? args[appsIdx + 1]?.split(",") : null;

// ---------------------------------------------------------------------------
// Source-specific prompts
// ---------------------------------------------------------------------------

const SCHEMA_INSTRUCTION = `
Output ONLY valid JSON (no markdown, no code fences, no explanation) with this exact structure:

{
  "source": "gmail",
  "extracted_at": "ISO timestamp",
  "content_nodes": [
    {
      "id": "unique id from source (e.g. gmail message id)",
      "type": "email | video | post | note | article",
      "title": "subject or title",
      "author": "sender or creator",
      "date": "ISO date",
      "snippet": "first 200 chars of content",
      "source_url": "link if available, null otherwise",
      "labels": ["INBOX", "UNREAD", etc],
      "urgency": "action_required | time_sensitive | informational | noise",
      "urgency_reason": "why this urgency level"
    }
  ],
  "entities": [
    {
      "name": "entity name",
      "type": "person | company | service | project | tool | concept",
      "mentions": ["content_node_id1", "content_node_id2"]
    }
  ],
  "topics": [
    {
      "name": "topic name (lowercase, e.g. 'infrastructure', 'finance', 'ml')",
      "content_ids": ["content_node_id1"]
    }
  ],
  "edges": [
    {
      "from_id": "content_node_id or entity_name",
      "to_id": "content_node_id or entity_name",
      "type": "ABOUT | MENTIONS | SIMILAR_TO | RELATES_TO",
      "reason": "why this connection"
    }
  ],
  "summary": {
    "total_items": 10,
    "action_required": ["brief description of each action item"],
    "top_topics": ["topic1", "topic2"],
    "consensus": "if multiple items discuss the same thing, note it here"
  }
}`;

function getSourcePrompt(source: string, limit: number, queryFilter: string | null): string {
  switch (source) {
    case "gmail":
      return `You are a knowledge graph ingestion agent. Your job is to:

1. Search Gmail for recent emails using search_gmail with query "${queryFilter ?? "newer_than:3d"}" and limit ${limit}
2. For emails that look important (not pure spam/promo), use read_email to get the full body
3. Extract entities, topics, urgency, and connections from ALL emails
4. Output the result as structured JSON

Rules:
- Classify urgency honestly: "action_required" = needs a response/action, "noise" = pure promo/spam
- Extract entities that are SPECIFIC (not generic words) — company names, people, services, projects
- Find CROSS-EMAIL connections: if two emails mention the same entity or topic, create an edge
- Topics should be broad categories: "infrastructure", "finance", "career", "learning", "social"
- The consensus field: if 2+ emails are about the same thing, call it out

${SCHEMA_INSTRUCTION}`;

    case "notifications": {
      if (!inputFile) {
        console.error("notifications source requires --file <path>");
        process.exit(1);
      }

      const raw = JSON.parse(readFileSync(inputFile, "utf-8"));

      // App package name → readable source mapping
      const APP_MAP: Record<string, string> = {
        "com.google.android.youtube": "YouTube",
        "com.reddit.frontpage": "Reddit",
        "com.substack.app": "Substack",
        "com.medium.reader": "Medium",
        "com.linkedin.android": "LinkedIn",
        "com.instagram.android": "Instagram",
        "com.zoho.mail": "Zoho Mail",
        "com.microsoft.office.outlook": "Outlook",
        "com.google.android.apps.magazines": "Google News",
        "com.google.android.googlequicksearchbox": "Google",
        "com.discord": "Discord",
        "com.pinterest": "Pinterest",
        "com.popular.android.mibanco": "Banco Popular",
        "com.teslamotors.tesla": "Tesla",
      };

      // Filter by apps if specified, otherwise take content-rich apps
      const defaultApps = ["YouTube", "Reddit", "Substack", "Medium", "LinkedIn", "Google News"];
      const allowedApps = appsFilter ?? defaultApps;

      const filtered = raw.filter((n: any) => {
        const appName = APP_MAP[n.packageName] ?? n.packageName;
        return allowedApps.some((a: string) => appName.toLowerCase().includes(a.toLowerCase()));
      }).filter((n: any) => n.title && n.title.length > 0);

      // Take up to limit
      const subset = filtered.slice(0, limit);

      const notifsText = subset.map((n: any, i: number) => {
        const app = APP_MAP[n.packageName] ?? n.packageName;
        return `[${i + 1}] App: ${app}\n    Title: ${n.title}\n    Content: ${n.content ?? ""}\n    When: ${n.when}`;
      }).join("\n\n");

      return `You are a knowledge graph ingestion agent. You have two jobs:

STEP 1 — DISCOVERY: I'm giving you ${subset.length} Android notifications from different apps. These are the INDEX — they tell you WHAT exists but not the full content.

STEP 2 — ENRICHMENT: For the most interesting/valuable notifications:
- YouTube videos → use fetch_url to get the video metadata and transcript (the MEAT)
- Reddit posts → use fetch_url to get the full post and comments
- Substack/Medium articles → use fetch_url to get the full article text
- Anything with a URL in the content → fetch it

Focus enrichment on the TOP ${Math.min(5, subset.length)} most valuable items (learning, career, AI, tech — skip pure social/entertainment noise). Don't try to enrich ALL items.

Here are the notifications:

${notifsText}

Rules:
- Each notification becomes a content_node (even if you don't enrich it)
- Enriched items get full snippets from the fetched content
- urgency: "informational" for most, "action_required" only if something needs doing
- Find CROSS-SOURCE connections: a YouTube video about React + a Substack article about React = edge
- Topics should be broad: "ml", "react", "finance", "career", "infrastructure"
- The id field: use the notification index like "notif-1", "notif-2"

${SCHEMA_INSTRUCTION.replace('"gmail"', '"notifications"')}`;
    }

    case "youtube":
      return `You are a knowledge graph ingestion agent for YouTube.

1. I'll provide YouTube URLs or search terms
2. Use fetch_url to get video metadata and transcripts
3. Extract entities, topics, and connections
4. Output structured JSON

${SCHEMA_INSTRUCTION.replace('"gmail"', '"youtube"')}`;

    case "obsidian":
      return `You are a knowledge graph ingestion agent for Obsidian notes.

1. Use the obsidian tools to read recent notes
2. Extract entities, topics, backlinks, and connections
3. Output structured JSON

${SCHEMA_INSTRUCTION.replace('"gmail"', '"obsidian"')}`;

    default:
      console.error(`Unknown source: ${source}. Supported: gmail, notifications, youtube, obsidian`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const prompt = getSourcePrompt(source, limit, queryFilter);

  console.error(`\n[ingest] source: ${source}`);
  console.error(`[ingest] limit: ${limit}`);
  console.error(`[ingest] output: ${outPath ?? "stdout"}`);
  if (queryFilter) console.error(`[ingest] query: ${queryFilter}`);
  console.error(`[ingest] running...\n`);

  const result = await runClaude(
    {
      prompt,
      mcpServers: getMcpServers(),
      allowedTools: getAllowedTools(),
      dangerouslySkipPermissions: true,
      binaryPath: "/data/data/com.termux/files/usr/bin/claude",
      maxTurns: 40,
      maxBudgetUsd: 2.00,
      systemPrompt: "You are a knowledge graph ingestion agent. You extract structured data from content sources. Always output valid JSON only — no markdown, no explanation, no code fences.",
    },
    {
      onToolUse(name, input) {
        const summary = JSON.stringify(input).slice(0, 80);
        console.error(`[tool] ${name}(${summary})`);
      },
    },
  );

  console.error(`[ingest] finished — success: ${result.success}, cost: $${result.costUsd.toFixed(4)}, turns: ${result.numTurns}`);
  if (result.errors.length > 0) {
    console.error(`[ingest] errors:`, result.errors);
  }
  console.error(`[ingest] output length: ${result.output.length} chars`);

  // Extract JSON from output — strip any text before/after the JSON object
  let json = result.output.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Find the JSON object even if the LLM added text around it
  const firstBrace = json.indexOf("{");
  const lastBrace = json.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    json = json.slice(firstBrace, lastBrace + 1);
  }

  // Validate and pretty-print
  try {
    const parsed = JSON.parse(json);
    json = JSON.stringify(parsed, null, 2);
  } catch {
    console.error("[ingest] WARNING: output is not valid JSON, writing raw output");
  }

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n");
    console.error(`[ingest] wrote ${json.length} bytes to ${outPath}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
