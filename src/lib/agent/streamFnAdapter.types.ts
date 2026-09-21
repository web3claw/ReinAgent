/**
 * streamFnAdapter · 编译期形状证明（**只有类型，无运行时副作用**）。
 *
 * 本文件**不被任何模块 import** —— 是刻意的类型灯标：
 *   - Vite 只打包入口可达的模块，孤儿文件不会进 bundle；
 *   - 但 `tsc`（`bun run build` 里的 `tsc` 步骤）会检查它。
 * 因此：只要本文件能编译通过，就**证明**适配器的返回值确实满足库要的 `StreamFn` 形状。
 *
 * 若哪天有人改坏了 `createStreamFnAdapter` 的签名，这里会**先于**运行期测试报错 ——
 * 比运行期测试更早发现问题。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";

import { createStreamFnAdapter } from "./streamFnAdapter";

/**
 * ✅ 正证：把 `createStreamFnAdapter(...)` 的结果赋给一个 `StreamFn` 类型变量。
 * 编译通过 ⇔ 适配器的返回值形状 = 库要求的 `StreamFn`。
 * （`openaiCompletionsStream` 的静态类型是
 *   `StreamFunction<"openai-completions", OpenAICompletionsOptions>`，
 *   即被收窄到具体 api 的 provider 级 stream。）
 */
export const adaptedStreamFn: StreamFn = createStreamFnAdapter({
  stream: openaiCompletionsStream,
  api: "openai-completions",
  label: "deepseek",
});

/*
 * ---------------------------------------------------------------------------
 * 反证（**故意不成立**，故只能以注释留存）：直接赋值会 tsc 报错，证明适配器不可省略。
 *
 * 若写下：
 *
 *     const naive: StreamFn = openaiCompletionsStream;
 *
 * 会得到实测报错原文：
 *
 *   TS2322: Type 'StreamFunction<"openai-completions", OpenAICompletionsOptions>' is not assignable
 *           to type 'StreamFn'.
 *     Types of parameters 'model' and 'model' are incompatible.
 *       Type 'Model<Api>' is not assignable to type 'Model<"openai-completions">'.
 *
 * 即：`StreamFn` 必须面对**任意 api**（形参是 `Model<Api>`），而 provider 级 `stream` 已被
 * 窄化到 `Model<"openai-completions">`。**只有 `model` 这一个参数不兼容**
 * （`context` / `options` / 返回类型都通过）。适配器正是在唯一一处补上这个收窄，
 * 并配运行期守卫兜底（绝不使用 `as` / `any` 骗过 tsc）。
 * ---------------------------------------------------------------------------
 */
