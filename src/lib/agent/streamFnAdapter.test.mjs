/**
 * streamFnAdapter 的自动化验证（S7-1）。
 *
 * 覆盖适配器作为「收窄后转发」的全部行为契约：
 *   1. 三件入参（model / context / options）**原样**透传（引用相等，未克隆/改写/补字段）；
 *   2. 返回值**原样**返回（Promise 与同步值皆不额外 await / 包装）；
 *   3. api 不匹配 => 抛错，错误信息同时含期望值与实际值；
 *   4. model 缺 `api` 字段 => 也抛错（不静默通过）；
 *   5. faux 路径同样可用（证明工厂能覆盖两条路径）；
 *   6. 工厂无共享状态（两个适配器互不影响）；
 *   7. 不重复规范化（回归哨兵：context 引用原样到达，防后人「顺手加 normalizeContext」）。
 *
 * 全部使用**假的 stream 函数**（记录收到的参数），不联网、不依赖 faux 运行时。
 * 运行：node --test src/lib/agent/streamFnAdapter.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStreamFnAdapter } from "./streamFnAdapter.js";

/** 造一个最小可用的 `Model<"openai-completions">` 形状对象。 */
function model(api, extra = {}) {
  return { id: "test-model", provider: "test", api, ...extra };
}

test("透传一致性：model / context / options 三件原样交给注入的 stream（引用相等）", () => {
  let seen = null;
  const adapter = createStreamFnAdapter({
    stream: (m, c, o) => {
      seen = { m, c, o };
      return "stream-result";
    },
    api: "openai-completions",
    label: "deepseek",
  });

  const m = model("openai-completions");
  const c = { messages: [] };
  const o = { apiKey: "sk-test", signal: undefined };

  adapter(m, c, o);

  assert.notEqual(seen, null, "注入的 stream 必须被调用");
  assert.strictEqual(seen.m, m, "model 必须是同一引用（未被克隆/改写）");
  assert.strictEqual(seen.c, c, "context 必须是同一引用（未补字段/未规范化）");
  assert.strictEqual(seen.o, o, "options 必须是同一引用（未改 apiKey/未注入 signal）");
});

test("入参缺省：adaptor(model, context) 时透传给 stream 的 options 为 undefined（不补默认对象）", () => {
  let seen = null;
  const adapter = createStreamFnAdapter({
    stream: (m, c, o) => {
      seen = o;
      return null;
    },
    api: "openai-completions",
  });

  adapter(model("openai-completions"), { messages: [] });
  assert.strictEqual(seen, undefined, "未传 options 时必须原样透传 undefined，不得补一个默认对象");
});

test("返回值原样（Promise）：注入的 stream 返回 Promise 时，适配器返回同一个 Promise，无额外 await/包装", async () => {
  const sentinel = Promise.resolve("async-result");
  const adapter = createStreamFnAdapter({
    stream: () => sentinel,
    api: "openai-completions",
  });

  const returned = adapter(model("openai-completions"), { messages: [] }, {});
  assert.strictEqual(returned, sentinel, "必须返回同一个 Promise 引用（strictEqual 证明没有另起包装）");
  assert.equal(await returned, "async-result");
});

test("返回值原样（同步值）：注入的 stream 返回同步值时，适配器原样返回该值", () => {
  const syncValue = { kind: "sync-stream" };
  const adapter = createStreamFnAdapter({
    stream: () => syncValue,
    api: "openai-completions",
  });

  const returned = adapter(model("openai-completions"), { messages: [] }, {});
  assert.strictEqual(returned, syncValue, "同步返回值必须原样返回");
});

test("api 不匹配：抛错，且错误信息同时含「期望值」与「实际值」", () => {
  const adapter = createStreamFnAdapter({
    stream: () => null,
    api: "openai-completions",
    label: "deepseek",
  });

  assert.throws(
    () => adapter(model("anthropic-messages"), { messages: [] }, {}),
    (err) => {
      assert.ok(err instanceof Error, "必须抛 Error");
      assert.match(err.message, /openai-completions/, "错误信息须含期望 api");
      assert.match(err.message, /anthropic-messages/, "错误信息须含实际 api");
      assert.match(err.message, /deepseek/, "错误信息须含 label，便于定位来源");
      return true;
    },
  );
});

test("model 缺 api 字段：也抛错（不静默通过）", () => {
  const adapter = createStreamFnAdapter({
    stream: () => null,
    api: "openai-completions",
  });

  assert.throws(
    () => adapter({ id: "no-api-field", provider: "test" }, { messages: [] }, {}),
    Error,
    "model 无 api 字段 => undefined !== 'openai-completions'，必须抛错而非静默通过",
  );

  assert.throws(() => adapter(null, { messages: [] }, {}), Error, "model 为 null 必须抛错");
  assert.throws(() => adapter(undefined, { messages: [] }, {}), Error, "model 为 undefined 必须抛错");
});

test("faux 路径可用：api: 'faux' 的工厂能正常透传（证明覆盖两条路径）", () => {
  let seen = null;
  const adapter = createStreamFnAdapter({
    stream: (m, c, o) => {
      seen = { m, c, o };
      return "faux-stream";
    },
    api: "faux",
    label: "faux",
  });

  const m = { id: "faux-model", provider: "faux", api: "faux" };
  const c = { messages: [] };
  const result = adapter(m, c, { signal: undefined });

  assert.equal(result, "faux-stream");
  assert.strictEqual(seen.m, m);
  assert.strictEqual(seen.c, c);
});

test("工厂无共享状态：两个适配器交替调用，各自只收到自己的调用", () => {
  const callsA = [];
  const callsB = [];
  const adapterA = createStreamFnAdapter({
    stream: (m) => {
      callsA.push(m);
      return "A";
    },
    api: "openai-completions",
    label: "A",
  });
  const adapterB = createStreamFnAdapter({
    stream: (m) => {
      callsB.push(m);
      return "B";
    },
    api: "faux",
    label: "B",
  });

  const modelA = model("openai-completions");
  const modelB = { id: "faux-model", provider: "faux", api: "faux" };

  assert.equal(adapterA(modelA, { messages: [] }, {}), "A");
  assert.equal(adapterB(modelB, { messages: [] }, {}), "B");
  assert.equal(adapterA(modelA, { messages: [] }, {}), "A");

  assert.deepEqual(callsA, [modelA, modelA], "A 只应收到自己的两次调用");
  assert.deepEqual(callsB, [modelB], "B 只应收到自己的一次调用");
  assert.notStrictEqual(adapterA, adapterB, "两个工厂产出的是两个不同的函数");
});

test("不重复规范化（回归哨兵）：context 以同一引用到达注入的 stream，绝不被归一化/克隆", () => {
  let received = null;
  const adapter = createStreamFnAdapter({
    stream: (m, c) => {
      received = c;
      return null;
    },
    api: "openai-completions",
  });

  // 冻结 + 自定义标记：任何「顺手 normalizeContext」/克隆都会换掉引用或丢失标记。
  const context = Object.freeze({
    messages: [{ role: "user", content: "hi" }],
    __marker: "verbatim-context",
  });

  adapter(model("openai-completions"), context, {});

  assert.strictEqual(received, context, "context 必须是同一引用（严禁在适配器内二次 normalizeContext）");
  assert.equal(received.__marker, "verbatim-context", "自定义标记必须原样保留");
});

test("工厂本身入参校验：stream 非函数 / api 非字符串时，构造即抛错", () => {
  assert.throws(() => createStreamFnAdapter({ stream: null, api: "openai-completions" }), TypeError);
  assert.throws(() => createStreamFnAdapter({ stream: () => null, api: "" }), TypeError);
  assert.throws(() => createStreamFnAdapter({ stream: () => null }), TypeError);
});
