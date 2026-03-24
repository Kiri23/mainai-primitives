/**
 * Demo: Run Claude via Agent SDK (replaces `claude -p`).
 *
 * Usage:
 *   npx tsx src/demo.ts "What files are in this directory?"
 *   npx tsx src/demo.ts --stream "Explain this codebase"
 *   npx tsx src/demo.ts --repl                              # interactive multi-turn
 */
import * as readline from "node:readline";
import { runClaude, createSession } from "./claude-runner.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const args = process.argv.slice(2);
const streaming = args.includes("--stream");
const repl = args.includes("--repl");
const prompt = args.filter((a) => !a.startsWith("--")).join(" ") || "What files are in this directory?";

async function demoSingleShot() {
  console.log(`\n--- Single-shot mode ---`);
  console.log(`Prompt: "${prompt}"\n`);

  const result = await runClaude(
    {
      prompt,
      includePartialMessages: streaming,
    },
    {
      onTextDelta: streaming ? (text) => process.stdout.write(text) : undefined,
      onToolUse: (name, input) => {
        console.log(`\n[tool] ${name}:`, JSON.stringify(input).slice(0, 200));
      },
      onSystemInit: (info) => {
        console.log(`[init] model=${info.model} session=${info.session_id}`);
        console.log(`[init] tools: ${info.tools.join(", ")}`);
      },
    },
  );

  if (streaming) console.log();
  console.log(`\n--- Result ---`);
  console.log(`Success: ${result.success}`);
  console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  console.log(`Turns: ${result.numTurns}`);
  console.log(`Session ID: ${result.sessionId} (use --resume to continue)`);
  if (!streaming) {
    console.log(`\nOutput:\n${result.output}`);
  }
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.join(", ")}`);
  }
}

async function demoRepl() {
  console.log(`\n--- Interactive REPL (multi-turn session) ---`);
  console.log(`Type a message and press Enter. Ctrl+C or "exit" to quit.\n`);

  const session = createSession({ includePartialMessages: true });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Track when Claude is "thinking" vs waiting for input
  let waitingForResponse = false;
  let sessionId = "";
  let totalCost = 0;

  // Consume SDK messages in background
  const messageLoop = (async () => {
    for await (const message of session.messages) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            sessionId = message.session_id;
            console.log(`[session ${sessionId}] model=${message.model}\n`);
          }
          break;
        }

        case "stream_event": {
          const event = (message as { event: { type: string; delta?: { text?: string } } }).event;
          if (event.type === "content_block_delta" && event.delta?.text) {
            process.stdout.write(event.delta.text);
          }
          break;
        }

        case "assistant": {
          // Final assistant message — we already streamed the text via stream_event,
          // but log tool uses
          for (const block of message.message.content) {
            if ("type" in block && block.type === "tool_use") {
              const toolBlock = block as { name: string; input: Record<string, unknown> };
              console.log(`\n[tool] ${toolBlock.name}: ${JSON.stringify(toolBlock.input).slice(0, 200)}`);
            }
          }
          break;
        }

        case "result": {
          totalCost = message.total_cost_usd;
          const costStr = `$${totalCost.toFixed(4)}`;
          console.log(`\n[turn done | cost so far: ${costStr}]\n`);
          waitingForResponse = false;
          rl.prompt();
          break;
        }
      }
    }
  })();

  // Handle user input
  rl.setPrompt("you> ");

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit") {
      console.log(`\nClosing session. Total cost: $${totalCost.toFixed(4)}`);
      session.close();
      rl.close();
      return;
    }
    if (trimmed === "") {
      rl.prompt();
      return;
    }
    if (waitingForResponse) {
      console.log("[waiting for Claude to finish...]");
      return;
    }

    waitingForResponse = true;
    console.log(); // blank line before response
    session.sendMessage(trimmed);
  });

  rl.on("close", () => {
    session.close();
  });

  // Send initial prompt if provided via args
  if (prompt !== "What files are in this directory?" || args.some((a) => !a.startsWith("--"))) {
    console.log(`you> ${prompt}\n`);
    waitingForResponse = true;
    session.sendMessage(prompt);
  } else {
    rl.prompt();
  }

  await messageLoop;
}

if (repl) {
  demoRepl().catch(console.error);
} else {
  demoSingleShot().catch(console.error);
}
