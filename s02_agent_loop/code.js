import { input } from "@inquirer/prompts";
import { execa } from "execa";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ override: true });

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID;

const WORKSPACE_ROOT = process.cwd();

const SYSTEM = `你是位于 ${WORKSPACE_ROOT} 的 code agent。请优先使用 read_file / write_file 读写文件，必要时使用 bash 解决任务，只需执行，不要解释。`;

// ── 工具定义 ───────────────────────────────────────
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
  {
    name: "read_file",
    description: "读取工作区内指定路径的文本文件。",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径，可以是相对工作区的路径，也可以是工作区内的绝对路径。",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "写入工作区内指定路径的文本文件；如果文件已存在会覆盖。",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要写入的文件路径，可以是相对工作区的路径，也可以是工作区内的绝对路径。",
        },
        content: {
          type: "string",
          description: "要写入文件的完整文本内容。",
        },
      },
      required: ["path", "content"],
    },
  },
];

// ── 工具执行 ────────────────────────────────────────
const toolHandlers = {
  bash: runBash,
  read_file: readWorkspaceFile,
  write_file: writeWorkspaceFile,
};

function resolveWorkspacePath(requestedPath) {
  // 统一处理相对路径和绝对路径，并在文件操作前确保目标路径仍在当前工作区内。
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(WORKSPACE_ROOT, requestedPath);

  const relativePath = path.relative(WORKSPACE_ROOT, absolutePath);
  const isOutsideWorkspace =
    relativePath.startsWith("..") || path.isAbsolute(relativePath);

  if (isOutsideWorkspace) {
    throw new Error(`Path is outside workspace: ${requestedPath}`);
  }

  return absolutePath;
}

async function runBash({ command }) {
  if (typeof command !== "string") {
    return "Error: bash command must be a string";
  }

  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((dangerousCommand) => command.includes(dangerousCommand))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout } = await execa(command, {
      shell: true,
      cwd: WORKSPACE_ROOT,
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout.trim().slice(0, 50_000) || "(no output)";
  } catch (error) {
    if (error.timedOut) return "Error: Timeout (120s)";
    if (error.stderr) return error.stderr.trim().slice(0, 50_000);
    return `Error: ${error.message}`;
  }
}

async function readWorkspaceFile({ path: requestedPath }) {
  try {
    const absolutePath = resolveWorkspacePath(requestedPath);
    const fileContent = await readFile(absolutePath, "utf8");
    return fileContent.slice(0, 50_000) || "(empty file)";
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function writeWorkspaceFile({ path: requestedPath, content }) {
  try {
    const absolutePath = resolveWorkspacePath(requestedPath);
    await writeFile(absolutePath, content, "utf8");
    return `Wrote ${content.length} characters to ${requestedPath}`;
  } catch (error) {
    return `Error: ${error.message}`;
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

      process.stderr.write(`[debug] tool_use: ${block.name}\n`);

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
  console.log("s02: Agent Loop (JavaScript)");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history = [];

  while (true) {
    const answer = await input({ message: "s02" });
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

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
