/**
 * 知识源跳转解析验证（node:test）。
 * 运行：node --test src/lib/knowledge/sourceLinks.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKnowledgeSourceId, firstNavigableSourceId } from "./sourceLinks.ts";

test("parse：note / wiki / import 三路 + 根笔记无前缀", () => {
  assert.deepEqual(parseKnowledgeSourceId("default:子目录/a.md"), {
    kind: "note", notebookRelPath: "default", fileName: "子目录/a.md",
  });
  assert.deepEqual(parseKnowledgeSourceId("note:default:子目录/a.md"), {
    kind: "note", notebookRelPath: "default", fileName: "子目录/a.md",
  });
  assert.deepEqual(parseKnowledgeSourceId("note:a.md"), {
    kind: "note", notebookRelPath: "", fileName: "a.md",
  });
  assert.deepEqual(parseKnowledgeSourceId("a.md"), { kind: "note", notebookRelPath: "", fileName: "a.md" });
  assert.deepEqual(parseKnowledgeSourceId("wiki:wdoc-123"), { kind: "wiki", docId: "wdoc-123" });
  assert.deepEqual(parseKnowledgeSourceId("import-task-9"), { kind: "import", taskId: "import-task-9" });
});

test("parse：未知形态一律 unknown（不猜）", () => {
  assert.equal(parseKnowledgeSourceId("").kind, "unknown");
  assert.equal(parseKnowledgeSourceId("plain-text").kind, "unknown");
  assert.equal(parseKnowledgeSourceId("wiki:").kind, "unknown");
  assert.equal(parseKnowledgeSourceId(":empty-notebook").kind, "unknown");
});

test("firstNavigableSourceId：跳过手工（null）与未知来源", () => {
  assert.equal(
    firstNavigableSourceId([{ sourceId: null }, { sourceId: "plain" }, { sourceId: "wiki:x" }]),
    "wiki:x",
  );
  assert.equal(firstNavigableSourceId([{ sourceId: null }]), null);
  assert.equal(firstNavigableSourceId([]), null);
});
