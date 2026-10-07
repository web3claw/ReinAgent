/**
 * initPrompt.ts —— `/init` 内置命令的提示词模板（ZCode builtin-prompt-command.ts 移植）。
 *
 * ZCode 语义：`/init [notes]` 不执行宿主逻辑，而是把输入**展开为一段普通提示词**发给
 * 模型跑一个正常回合——检查工作区、创建或更新根目录 `AGENTS.md`；已存在则编辑补充
 * 而不整体覆盖；只动当前工作区。带参数时按 ZCode 原文格式追加为「Additional user
 * instructions」段落。适配点见 PROMPTS.md（工具名改 ReinAgent 工具、候选指令文件
 * 按 agents_md.rs 的 CANDIDATES 清单、去掉用户级 ~/.zcode/AGENTS.md 说明）。
 */

/** 与工作区路径同风格的拼接（Windows 反斜杠 / POSIX 斜杠，不引入 path 依赖）。 */
function joinWorkspacePath(root: string, name: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const sep = /^[A-Za-z]:/.test(trimmed) || trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}${name}`;
}

export function buildInitAgentsPrompt(params: { args: string; workingDirectory: string }): string {
  const workingDirectory = params.workingDirectory.trim();
  const targetPath = joinWorkspacePath(workingDirectory, "AGENTS.md");
  const additionalInstructions = params.args
    ? [
        "",
        "Additional user instructions supplied with /init:",
        "```text",
        params.args,
        "```",
      ].join("\n")
    : "";

  return [
    "You are running ReinAgent's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ReinAgent agents.",
    "",
    "Target:",
    `- Workspace directory: ${workingDirectory}`,
    `- Instruction file: ${targetPath}`,
    `- Existing alternative instruction files to detect: ${joinWorkspacePath(workingDirectory, ".agents/AGENTS.md")}, ${joinWorkspacePath(workingDirectory, "CLAUDE.md")}, and ${joinWorkspacePath(workingDirectory, ".claude/CLAUDE.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write files outside the workspace.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .agents/AGENTS.md, CLAUDE.md, or .claude/CLAUDE.md exists in the workspace. If any exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer read_file, list_dir, glob, and grep; use exec_command only for safe inspection commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with edit_file instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root with write_file.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future ReinAgent agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}
