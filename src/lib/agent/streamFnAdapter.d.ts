/**
 * streamFnAdapter 的类型声明（实现见同目录 `streamFnAdapter.js`）。
 *
 * 采用本项目既有做法「纯 `.js` 逻辑 + 手写 `.d.ts`」：
 *   - Node（`node --test`）直接加载 `.js`；
 *   - TS/Vite 取本 `.d.ts` 做类型检查；
 * 无需任何预编译步骤。可参考 `src/lib/chat/conversationModel.d.ts` 的同款模式。
 *
 * ⚠ 运行时导入纪律（本项目硬性纪律 #2）：
 *   `.js` 实现里**没有任何运行时 import**（纯透传，不需要 import），因此不会从
 *   pi-agent-core / pi-ai 的**桶文件**拖入 `node:fs/promises` 之类的 Node 内置，
 *   不会污染浏览器 bundle。本文件里的 import **全部是 `import type`**（类型位置，
 *   编译期即被擦除），从桶文件取类型是允许且安全的。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, TranscriptContext } from "@earendil-works/pi-ai";

/**
 * 可注入的 provider 级 stream 的形状。
 *
 * 这是**注入边界**，因此刻意宽松：每个 provider 级 stream 都被窄化到自己的 api
 * （如 `StreamFunction<"openai-completions", OpenAICompletionsOptions>`、
 * faux 的 `StreamFunction<string, SimpleStreamOptions>`），不存在一个精确类型能
 * 同时表达它们。收窄与运行期守卫发生在适配器内部（见 `.js`）。
 *
 * `context` 用 `TranscriptContext` 而非 `any`，以保留「一定是规范化后的上下文」这一约束。
 */
export type ProviderStreamFn = (
  model: any,
  context: TranscriptContext,
  options?: any,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** `createStreamFnAdapter` 的工厂入参。 */
export interface StreamFnAdapterOptions {
  /** provider 级 stream 函数（真实为 `api/openai-completions` 的 `stream`；测试里为 faux 的）。 */
  stream: ProviderStreamFn;
  /** 该 provider 级 stream 期望的 api 字符串（如 `"openai-completions"`）。用于运行期校验。 */
  api: string;
  /** 出错信息里用于标识来源（如 `"deepseek"` / `"faux"`）；缺省时回退为 `api`。 */
  label?: string;
}

/**
 * 创建一个满足 pi-agent-core `StreamFn` 形状的适配器。
 *
 * 返回的函数把 `(model, context, options)` **原样**转交给注入的 provider 级 stream：
 * 不规范化、不改 options、不 await（返回值原样返回）。
 * 唯一附加行为是运行期 api 校验：不匹配时抛出信息量足够的 `Error`。
 *
 * 返回值类型**必须是** `StreamFn` —— 这正是本模块存在的意义：在**唯一一处**完成
 * `Model<Api>` → `Model<具体 api>` 的类型收窄，让 provider 级 stream 能被库接受。
 */
export function createStreamFnAdapter(options: StreamFnAdapterOptions): StreamFn;
