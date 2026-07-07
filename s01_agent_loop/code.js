import { input } from "@inquirer/prompts";
import { execa } from "execa";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config({ override: true });

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID;

const SYSTEM = `你是位于 ${process.cwd()} 的 code agent。请使用 bash 解决任务，只需执行，不要解释。`;

// ── 工具定义：只有 bash ────────────────────────────
const TOOLS = [
  {
    name: "bash",
    description: "运行一条 shell 命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

// ── 工具执行 ────────────────────────────────────────
const toolHandlers = {
  bash: runBash,
  // 新增工具在这里加一行
};

async function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout } = await execa(command, {
      shell: true,
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout.trim().slice(0, 50_000) || "(no output)";
  } catch (err) {
    if (err.timedOut) return "Error: Timeout (120s)";
    if (err.stderr) return err.stderr.trim().slice(0, 50_000);
    return `Error: ${err.message}`;
  }
}

// ── 核心模式：循环调用工具，直到模型停止 ──
async function agentLoop(messages) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const handler = toolHandlers[block.name];
      if (!handler) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: Unknown tool "${block.name}"`,
        });
        continue;
      }

      const output = await handler(block.input);
      process.stdout.write(`${output.slice(0, 200)}\n`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
async function main() {
  console.log("s01: Agent Loop (JavaScript)");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history = [];

  while (true) {
    const answer = await input({ message: "s01" });
    const trimmed = answer.trim();
    if (!trimmed || trimmed === "q" || trimmed === "exit") break;

    history.push({ role: "user", content: trimmed });
    await agentLoop(history);

    const lastContent = history.at(-1).content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") console.log(block.text);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
