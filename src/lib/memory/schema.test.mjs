import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENCE_CONTRACT,
  isMemoryScope,
  isMemoryType,
  MEMORY_CONFIDENCES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  normalizeMemoryConfidence,
} from "./schema.ts";

test("isMemoryScope：仅 global/project 合法，auto 只是过滤语义", () => {
  assert.equal(isMemoryScope("global"), true);
  assert.equal(isMemoryScope("project"), true);
  assert.equal(isMemoryScope("auto"), false);
  assert.equal(isMemoryScope("Global"), false);
  assert.equal(isMemoryScope(undefined), false);
});

test("isMemoryType：daily 是只读检索面，不是可写类型", () => {
  for (const type of ["user", "feedback", "project", "reference"]) {
    assert.equal(isMemoryType(type), true, type);
  }
  assert.equal(isMemoryType("daily"), false);
  assert.equal(isMemoryType(""), false);
});

test("normalizeMemoryConfidence：未知值一律落 unknown", () => {
  assert.equal(normalizeMemoryConfidence("high"), "high");
  assert.equal(normalizeMemoryConfidence("medium"), "medium");
  assert.equal(normalizeMemoryConfidence("low"), "low");
  assert.equal(normalizeMemoryConfidence("unknown"), "unknown");
  assert.equal(normalizeMemoryConfidence("HIGH"), "unknown");
  assert.equal(normalizeMemoryConfidence(undefined), "unknown");
  assert.equal(normalizeMemoryConfidence(42), "unknown");
});

test("常量表与置信度契约形状", () => {
  assert.deepEqual([...MEMORY_SCOPES], ["global", "project"]);
  assert.deepEqual([...MEMORY_TYPES], ["user", "feedback", "project", "reference"]);
  assert.deepEqual([...MEMORY_CONFIDENCES], ["high", "medium", "low", "unknown"]);
  assert.equal(CONFIDENCE_CONTRACT.highMinQuoteChars, 5);
  assert.equal(CONFIDENCE_CONTRACT.mediumMinQuoteChars, 1);
});
