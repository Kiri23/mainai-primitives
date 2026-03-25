/**
 * MainAI — Proof of Concept
 *
 * Claude Agent SDK + custom tools = personal AI that can search
 * and read your Gmail, fetch URLs, and more — autonomously.
 *
 * Usage:
 *   npx tsx src/mainai.ts "Resume el email de Nate sobre Accenture"
 *   npx tsx src/mainai.ts "https://www.youtube.com/watch?v=xyz"
 *   npx tsx src/mainai.ts --stream "Lee mi último email"
 *   npx tsx src/mainai.ts --repl                              # interactive multi-turn
 *   npx tsx src/mainai.ts --resume SESSION_ID "follow up question"
 */
import * as readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServers, getAllowedTools } from "./mcp-config.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const repl = args.includes("--repl");
const streaming = args.includes("--stream") || repl;
const resumeIdx = args.indexOf("--resume");
const resumeSessionId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;
const prompt = args
  .filter((a, i) => !a.startsWith("--") && (resumeIdx === -1 || i !== resumeIdx + 1))
  .join(" ") || (repl ? undefined : "¿Qué emails interesantes me llegaron hoy?");

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

const sharedOptions = {
  mcpServers: getMcpServers(),
  allowedTools: getAllowedTools(),
  tools: ["Read", "Glob", "Grep"] as string[],
  includePartialMessages: streaming,
  ...(resumeSessionId ? { resume: resumeSessionId } : {}),
};

// ---------------------------------------------------------------------------
// Message handler (shared between single-shot and repl)
// ---------------------------------------------------------------------------

function handleMessage(message: any, opts: { streaming: boolean }) {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        console.log(`[session: ${message.session_id}]`);
        console.log(`[model: ${message.model}]\n`);
      }
      break;
    }

    case "assistant": {
      for (const block of message.message.content) {
        if ("type" in block && block.type === "tool_use") {
          const tb = block as { name: string; input: Record<string, unknown> };
          console.log(`[tool] ${tb.name}(${JSON.stringify(tb.input)})`);
        }
      }
      break;
    }

    case "stream_event": {
      if (opts.streaming) {
        const event = (
          message as { event: { type: string; delta?: { text?: string } } }
        ).event;
        if (event.type === "content_block_delta" && event.delta?.text) {
          process.stdout.write(event.delta.text);
        }
      }
      break;
    }

    case "result": {
      if (opts.streaming) console.log();

      if (message.subtype === "success") {
        if (!opts.streaming) {
          console.log("\n--- Result ---");
          console.log(message.result);
        }
      } else {
        console.error("\n--- Error ---");
        console.error(message.subtype);
      }

      console.log(`\n[cost: $${message.total_cost_usd?.toFixed(4) ?? "?"}]`);
      console.log(`[turns: ${message.num_turns ?? "?"}]`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Single-shot mode
// ---------------------------------------------------------------------------

async function runSingleShot(userPrompt: string) {
  console.log(`\nMainAI`);
  console.log(`Prompt: "${userPrompt}"\n`);

  for await (const message of query({
    prompt: userPrompt,
    options: sharedOptions,
  })) {
    handleMessage(message, { streaming });
  }
}

// ---------------------------------------------------------------------------
// REPL mode — multi-turn interactive session
// ---------------------------------------------------------------------------

async function runRepl() {
  const isResuming = !!resumeSessionId;
  console.log(`\nMainAI — Interactive Session`);
  if (isResuming) {
    console.log(`Resuming session: ${resumeSessionId}`);
  } else {
    console.log(`New session`);
  }
  console.log(`Type a message and press Enter. "exit" to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let sessionId = resumeSessionId ?? "";
  let totalCost = 0;
  let waitingForResponse = false;

  async function sendMessage(text: string) {
    waitingForResponse = true;
    console.log();

    const options = {
      ...sharedOptions,
      ...(sessionId ? { resume: sessionId, continue: true } : {}),
    };

    for await (const message of query({ prompt: text, options })) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            sessionId = message.session_id;
            if (!isResuming) {
              console.log(`[session: ${sessionId}]`);
            }
            console.log(`[model: ${message.model}]\n`);
          }
          break;
        }

        case "stream_event": {
          const event = (
            message as { event: { type: string; delta?: { text?: string } } }
          ).event;
          if (event.type === "content_block_delta" && event.delta?.text) {
            process.stdout.write(event.delta.text);
          }
          break;
        }

        case "assistant": {
          for (const block of message.message.content) {
            if ("type" in block && block.type === "tool_use") {
              const tb = block as { name: string; input: Record<string, unknown> };
              console.log(`[tool] ${tb.name}(${JSON.stringify(tb.input)})`);
            }
          }
          break;
        }

        case "result": {
          console.log();
          totalCost = message.total_cost_usd ?? totalCost;
          console.log(`[cost: $${totalCost.toFixed(4)} | turns: ${message.num_turns ?? "?"}]\n`);
          break;
        }
      }
    }

    waitingForResponse = false;
    rl.prompt();
  }

  rl.setPrompt("you> ");

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit") {
      console.log(`\nSession: ${sessionId}`);
      console.log(`Total cost: $${totalCost.toFixed(4)}`);
      console.log(`Resume with: npx tsx src/mainai.ts --resume ${sessionId} "your message"`);
      rl.close();
      process.exit(0);
    }
    if (trimmed === "") { rl.prompt(); return; }
    if (waitingForResponse) { console.log("[waiting for Claude...]"); return; }
    sendMessage(trimmed);
  });

  rl.on("close", () => process.exit(0));

  // If a prompt was provided with --repl, send it first
  if (prompt) {
    sendMessage(prompt);
  } else {
    rl.prompt();
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (repl) {
  runRepl().catch(console.error);
} else {
  runSingleShot(prompt!).catch(console.error);
}
