/**
 * MainAI — Proof of Concept
 *
 * Claude Agent SDK + custom tools = personal AI that can search
 * and read your Gmail autonomously.
 *
 * Usage:
 *   npx tsx src/mainai.ts "Resume el email de Nate sobre Accenture"
 *   npx tsx src/mainai.ts "¿Qué emails me llegaron hoy?"
 *   npx tsx src/mainai.ts "Busca emails de Amazon con attachments"
 *   npx tsx src/mainai.ts --stream "Lee mi último email"
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { gmailServer } from "./tools/gmail.ts";

const args = process.argv.slice(2);
const streaming = args.includes("--stream");
const prompt = args
  .filter((a) => !a.startsWith("--"))
  .join(" ") || "¿Qué emails interesantes me llegaron hoy?";

console.log(`\n🧠 MainAI POC — Claude + Gmail Tools`);
console.log(`Prompt: "${prompt}"\n`);

for await (const message of query({
  prompt,
  options: {
    mcpServers: { gmail: gmailServer },
    allowedTools: ["mcp__gmail__*"],
    // Only give Claude our tools + basic read capabilities
    tools: ["Read", "Glob", "Grep"],
  },
})) {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        console.log(`[session: ${message.session_id}]`);
        console.log(`[model: ${message.model}]\n`);
      }
      break;
    }

    case "assistant": {
      // Log tool calls
      for (const block of message.message.content) {
        if ("type" in block && block.type === "tool_use") {
          const tb = block as { name: string; input: Record<string, unknown> };
          console.log(`[tool] ${tb.name}(${JSON.stringify(tb.input)})`);
        }
      }
      break;
    }

    case "stream_event": {
      if (streaming) {
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
      if (streaming) console.log();

      if (message.subtype === "success") {
        if (!streaming) {
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
