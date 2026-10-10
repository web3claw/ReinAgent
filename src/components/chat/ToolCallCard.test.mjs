import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("ToolCallCard 源码中 agent 与 subagent_output 均支持 summaryAction 唤起子代理面板", () => {
  const content = fs.readFileSync(path.resolve("src/components/chat/ToolCallCard.tsx"), "utf8");
  
  // 检查 agent 分支
  assert.ok(content.includes('if (entry.toolName === "agent")'), "存在 agent 分支");
  assert.ok(content.includes('type: "subagents"'), "存在打开 subagents 面板调用");
  
  // 检查 subagent_output 分支
  assert.ok(content.includes('if (entry.toolName === "subagent_output")'), "存在 subagent_output 分支");
  assert.ok(content.includes('focusId: subagentId'), "subagent_output 正确传递 focusId");
});
