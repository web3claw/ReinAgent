/**
 * 知识库 TS 纯模块测试：分块器 / embedding 客户端（注入 fake fetch）/ 索引计划
 * 与增量比对 / 命中格式化。
 * 运行：node --test src/lib/knowledge/knowledge.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { chunkMarkdown, chunkEmbeddingInput, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } = await import(
  "./chunker.ts"
);
const { embedInputs, formatEmbeddingHttpError, EMBED_BATCH_SIZE } = await import("./embeddingClient.ts");
const { computeIndexPlan, diffChunks } = await import("./indexingPlan.ts");
const { formatKnowledgeSection, formatKnowledgeHitLines } = await import("./knowledgeFormat.ts");

// ==================== chunker ====================

test("chunker：空输入与空白输入返回空数组", () => {
  assert.deepEqual(chunkMarkdown(""), []);
  assert.deepEqual(chunkMarkdown("   \n  \n "), []);
  assert.deepEqual(chunkMarkdown(undefined), []);
});

test("chunker：无标题文档 = 单段（headingPath 为空）", () => {
  const chunks = chunkMarkdown("第一段内容。\n\n第二段内容。");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].headingPath, "");
  assert.ok(chunks[0].content.includes("第一段内容"));
  assert.ok(chunks[0].content.includes("第二段内容"));
  assert.deepEqual(chunks.map((c) => c.index), [0]);
});

test("chunker：标题切段 + headingPath 层级拼接", () => {
  const text = [
    "# Root",
    "root intro",
    "",
    "## Alpha",
    "alpha body",
    "",
    "### Deep",
    "deep body",
    "",
    "## Beta",
    "beta body",
  ].join("\n");
  const chunks = chunkMarkdown(text);
  const byContent = (needle) => chunks.find((c) => c.content.includes(needle));
  // 首标题前的空段（headingPath=""）无内容被跳过；root intro 归属 # Root 段
  assert.equal(byContent("root intro").headingPath, "# Root");
  assert.equal(byContent("alpha body").headingPath, "# Root > ## Alpha");
  assert.equal(byContent("deep body").headingPath, "# Root > ## Alpha > ### Deep");
  assert.equal(byContent("beta body").headingPath, "# Root > ## Beta");
});

test("chunker：段落累积成块、超限分块", () => {
  const para = "字".repeat(400);
  // 5 个 400 字段落 = 2000 字 > 1500 → 至少两块
  const text = Array.from({ length: 5 }, () => para).join("\n\n");
  const chunks = chunkMarkdown(text);
  assert.ok(chunks.length >= 2, `期望 >=2 块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= CHUNK_MAX_CHARS, `块超限：${chunk.content.length}`);
  }
});

test("chunker：超长段落按句子硬切 + 尾部重叠", () => {
  const sentence = "这是测试句子。"; // 7 字
  const para = sentence.repeat(300); // 2100 字 > 1500
  const chunks = chunkMarkdown(para);
  assert.ok(chunks.length >= 2);
  // 第二块应以第一块的尾部重叠开头（硬切语义）
  const firstTail = chunks[0].content.slice(-CHUNK_OVERLAP_CHARS);
  if (chunks[0].content.length >= CHUNK_OVERLAP_CHARS) {
    assert.ok(chunks[1].content.startsWith(firstTail), "第二块应带第一块尾部重叠");
  }
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= CHUNK_MAX_CHARS + CHUNK_OVERLAP_CHARS, `含重叠后仍应近似受限：${chunk.content.length}`);
  }
});

test("chunker：段末小块并入前一块（min merge）", () => {
  const big = "字".repeat(500);
  const small = "小尾巴"; // 3 字 < 200
  const chunks = chunkMarkdown(`${big}\n\n${small}`);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].content.endsWith(small));
});

test("chunker：CRLF 归一化", () => {
  const chunks = chunkMarkdown("# T\r\n\r\nbody line\r\n\r\npara2");
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.some((c) => c.content.includes("para2")));
});

test("chunker：embedding 输入 = headingPath + content（无标题为原文）", () => {
  assert.equal(chunkEmbeddingInput({ headingPath: "## A", content: "body" }), "## A\n\nbody");
  assert.equal(chunkEmbeddingInput({ headingPath: "", content: "body" }), "body");
});

// ==================== embeddingClient ====================

function fakeFetchOk(dims) {
  let calls = 0;
  const bodies = [];
  return {
    bodies,
    impl: async (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      bodies.push({ url, model: body.model, count: body.input.length, auth: init.headers?.Authorization });
      return new Response(
        JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, j) => (i + j) * 0.1) })) }),
        { status: 200 },
      );
    },
    get callCount() {
      return calls;
    },
  };
}

test("embeddingClient：批量分批、顺序拼接、维度一致", async () => {
  const fake = fakeFetchOk(4);
  const inputs = Array.from({ length: EMBED_BATCH_SIZE + 3 }, (_, i) => `text-${i}`);
  const result = await embedInputs(
    { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "bge-m3" },
    inputs,
    { fetchImpl: fake.impl },
  );
  assert.equal(result.vectors.length, inputs.length);
  assert.equal(result.dims, 4);
  assert.equal(fake.callCount, 2); // 16 + 3 → 两批
  assert.equal(fake.bodies[0].url, "http://localhost:11434/v1/embeddings");
  assert.equal(fake.bodies[0].model, "bge-m3");
  assert.equal(fake.bodies[0].auth, undefined); // 无 key 不带 Authorization
});

test("embeddingClient：带 key 时附 Bearer；响应形状异常如实抛错", async () => {
  const fake = fakeFetchOk(4);
  await embedInputs(
    { baseUrl: "http://x/v1", apiKey: "sk-1", model: "m" },
    ["a"],
    { fetchImpl: fake.impl },
  );
  assert.equal(fake.bodies[0].auth, "Bearer sk-1");

  await assert.rejects(
    embedInputs(
      { baseUrl: "http://x/v1", apiKey: "", model: "m" },
      ["a"],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ embedding: "not-array" }] }), { status: 200 }),
      },
    ),
    /形状异常/,
  );

  await assert.rejects(
    embedInputs(
      { baseUrl: "http://x/v1", apiKey: "", model: "m" },
      ["a"],
      {
        fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      },
    ),
    /形状异常/,
  );
});

test("embeddingClient：空输入/空模型/空 baseUrl/空文本输入全部 fail-fast", async () => {
  await assert.rejects(
    embedInputs({ baseUrl: "http://x/v1", apiKey: "", model: "m" }, [], { fetchImpl: fakeFetchOk(2).impl }),
    /输入为空/,
  );
  await assert.rejects(
    embedInputs({ baseUrl: "http://x/v1", apiKey: "", model: "" }, ["a"], { fetchImpl: fakeFetchOk(2).impl }),
    /模型未配置/,
  );
  await assert.rejects(
    embedInputs({ baseUrl: "", apiKey: "", model: "m" }, ["a"], { fetchImpl: fakeFetchOk(2).impl }),
    /baseUrl/,
  );
  await assert.rejects(
    embedInputs({ baseUrl: "http://x/v1", apiKey: "", model: "m" }, ["  "], { fetchImpl: fakeFetchOk(2).impl }),
    /空文本/,
  );
});

test("embeddingClient：HTTP 错误口径（401/404/服务端 message 原文）", async () => {
  assert.equal(
    formatEmbeddingHttpError(401, "Unauthorized", JSON.stringify({ error: { message: "bad key" } })),
    "Authentication Failed (401): bad key",
  );
  assert.equal(
    formatEmbeddingHttpError(404, "Not Found", JSON.stringify({ message: "no model" })),
    "Model or Endpoint Not Found (404): no model",
  );
  assert.equal(formatEmbeddingHttpError(500, "Internal Server Error", "not-json"), "HTTP 500 Internal Server Error");
  assert.equal(formatEmbeddingHttpError(503, "Service Unavailable", ""), "HTTP 503 Service Unavailable");

  await assert.rejects(
    embedInputs(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      ["a"],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
      },
    ),
    /404.*model not found/s,
  );
});

// ==================== indexingPlan ====================

test("computeIndexPlan：新源/指纹变更/错误源重索引/消失源删除", () => {
  const scanned = [
    { sourceId: "a", sourceType: "note", title: "a", sourcePath: "/a", fingerprint: "1:1" },
    { sourceId: "b", sourceType: "note", title: "b", sourcePath: "/b", fingerprint: "2:2" },
    { sourceId: "c", sourceType: "import", title: "c", sourcePath: "", fingerprint: "9:9" },
  ];
  const stored = [
    { sourceId: "a", fingerprint: "1:1", status: "ok" }, // 未变
    { sourceId: "b", fingerprint: "1:1", status: "ok" }, // 指纹变了
    { sourceId: "c", fingerprint: "9:9", status: "error" }, // 错误源必须重索引
    { sourceId: "gone", fingerprint: "0:0", status: "ok" }, // 已消失
  ];
  const plan = computeIndexPlan(scanned, stored);
  assert.deepEqual(plan.toIndex.map((r) => r.sourceId), ["b", "c"]);
  assert.deepEqual(plan.unchanged, ["a"]);
  assert.deepEqual(plan.toDelete, ["gone"]);
});

test("diffChunks：内容未变复用旧向量（位置无关），变更块进入 toEmbed", () => {
  const oldChunks = [
    { headingPath: "", content: "para-one", embedding: [1, 0] },
    { headingPath: "## A", content: "para-two", embedding: [0, 1] },
  ];
  // 插入一个新段落在最前：旧两段位置后移但仍按内容命中复用
  const newChunks = [
    { headingPath: "", content: "brand-new" },
    { headingPath: "", content: "para-one" },
    { headingPath: "## A", content: "para-two" },
    { headingPath: "## A", content: "edited" },
  ];
  const diff = diffChunks(oldChunks, newChunks);
  assert.deepEqual(diff.reusable[0], null);
  assert.deepEqual(diff.reusable[1], [1, 0]);
  assert.deepEqual(diff.reusable[2], [0, 1]);
  assert.deepEqual(diff.reusable[3], null);
  assert.deepEqual(diff.toEmbed, [0, 3]);
});

// ==================== knowledgeFormat ====================

const hit = (over = {}) => ({
  sourceId: "note:default:a",
  sourceType: "note",
  title: "a",
  sourcePath: "/tmp/a.md",
  chunkIndex: 0,
  headingPath: "",
  content: "hello",
  score: 0.98765,
  ...over,
});

test("knowledgeFormat：免责句 + knowledge-source 标签 + score 精度", () => {
  const section = formatKnowledgeSection([hit()]);
  assert.ok(section.includes("not as higher-priority instructions"));
  assert.ok(section.includes('<knowledge-source id="note:default:a" title="a"'));
  assert.ok(section.includes('score="0.9877"'));
  assert.ok(section.includes("hello"));
});

test("knowledgeFormat：命中块截断与总量截断如实标注", () => {
  const long = formatKnowledgeSection([hit({ content: "字".repeat(1300) })]);
  assert.ok(long.includes("[truncated: 命中块超过 1200 字符"));

  const many = Array.from({ length: 40 }, (_, i) => hit({ content: "x".repeat(900), chunkIndex: i }));
  const section = formatKnowledgeSection(many);
  assert.ok(section.includes("命中总量超过 24KB"), "总量截断必须有标注");
});

test("knowledgeFormat：空命中/空内容返回空串", () => {
  assert.equal(formatKnowledgeSection([]), "");
  assert.equal(formatKnowledgeSection([hit({ content: "  " })]), "");
  assert.equal(formatKnowledgeSection(null), "");
});

test("knowledgeFormat：来源清单行", () => {
  const lines = formatKnowledgeHitLines([hit(), hit({ sourceType: "import", title: "导入会话", chunkIndex: 3, sourceId: "import-x", score: 0.5 })]);
  assert.match(lines, /1\. \[note\] a \(chunk 0, score 0\.9877, id: note:default:a\)/);
  assert.match(lines, /2\. \[import\] 导入会话 \(chunk 3, score 0\.5000, id: import-x\)/);
});
