/**
 * 知识命中格式化验证（node:test）：fromGraph 徽标 + 截断标注 + 免责句。
 * 运行：node --test src/lib/knowledge/knowledgeFormat.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatKnowledgeSection, formatKnowledgeHitLines } from "./knowledgeFormat.ts";

const hit = (over = {}) => ({
  sourceId: "note:default:a.md",
  sourceType: "note",
  title: "笔记 A",
  sourcePath: "/tmp/a.md",
  chunkIndex: 0,
  headingPath: "",
  content: "正文内容",
  score: 0.7123,
  ...over,
});

test("注入段：语义命中不带 graph 属性，图谱扩展带 graph=1", () => {
  const sem = formatKnowledgeSection([hit()]);
  assert.ok(!sem.includes('graph="1"'), "语义命中不应有 graph 标记");
  assert.ok(sem.includes('score="0.7123"'));
  const gp = formatKnowledgeSection([hit({ fromGraph: true, score: 0 })]);
  assert.ok(gp.includes('graph="1"'), "图谱扩展必须带 graph 标记");
  assert.ok(gp.includes('score="0.0000"'));
});

test("清单：图谱扩展行尾追加「· 图谱扩展」", () => {
  const lines = formatKnowledgeHitLines([hit(), hit({ fromGraph: true, title: "B" })]);
  const arr = lines.split("\n");
  assert.ok(!arr[0].includes("图谱扩展"));
  assert.ok(arr[1].includes("图谱扩展"));
});

test("混合命中：免责句保留且两个块都在", () => {
  const sec = formatKnowledgeSection([hit(), hit({ fromGraph: true, chunkIndex: 1 })]);
  assert.ok(sec.includes("local knowledge base"));
  assert.equal((sec.match(/<knowledge-source /g) ?? []).length, 2);
});
