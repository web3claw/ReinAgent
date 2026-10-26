/**
 * 知识图谱抽取解析验证（node:test）。
 * 运行：node --test src/lib/knowledge/graphExtract.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraphExtractionPrompt,
  parseGraphExtractionResponse,
} from "./graphExtractLogic.ts";

test("parse：纯 JSON / 围栏包裹 / 前后杂质文本三态容错", () => {
  const json = JSON.stringify({
    entities: [{ name: "React", type: "technology", description: "UI 库" }],
    relations: [{ source: "React", target: "Vite", relation: "related_to", description: "" }],
  });
  const plain = parseGraphExtractionResponse(json);
  assert.equal(plain?.entities.length, 1);
  const fenced = parseGraphExtractionResponse("好的，结果如下：\n```json\n" + json + "\n```");
  assert.equal(fenced?.relations.length, 1);
  const noisy = parseGraphExtractionResponse(`前缀废话 ${json} 后缀废话`);
  assert.equal(noisy?.entities[0].name, "React");
});

test("parse：非法输入与空结果返回 null", () => {
  assert.equal(parseGraphExtractionResponse("完全不是 JSON"), null);
  assert.equal(parseGraphExtractionResponse('{"entities":[],"relations":[]}'), null);
  assert.equal(parseGraphExtractionResponse('{"entities":[{"nope":1}],"relations":[]}'), null);
});

test("parse：字段缺失走缺省、空白实体名被过滤", () => {
  const parsed = parseGraphExtractionResponse(
    '{"entities":[{"name":" A ","type":123},{"name":"  ","type":"concept"}],"relations":[{"source":"A","target":"B"}]}',
  );
  assert.ok(parsed);
  assert.equal(parsed.entities.length, 1);
  assert.equal(parsed.entities[0].name, "A");
  assert.equal(parsed.entities[0].type, "");
  assert.equal(parsed.relations[0].relation, "");
});

test("prompt：含封闭枚举与 JSON 示例结构", () => {
  const p = buildGraphExtractionPrompt("标题", "内容");
  for (const t of ["concept", "person", "organization", "technology", "project"]) assert.ok(p.includes(t));
  for (const t of ["belong_to", "related_to", "depends_on", "contains", "compared_with"]) assert.ok(p.includes(t));
  assert.ok(p.includes('"entities"'));
  assert.ok(p.includes('"relations"'));
  assert.ok(p.includes("不要过度提取"));
});
