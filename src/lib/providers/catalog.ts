/**
 * 内置模型目录（DeepSeek）。
 *
 * 优先使用 pi-ai 自带的官方目录（`@earendil-works/pi-ai/providers/deepseek.models`），
 * 避免模型 id / 价格 / 上下文窗口变更后我们抄错。权威值来自
 * `node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json`。
 *
 * 说明：这是**运行时**导入（不是 `import type`），因为它要提供真实数据。
 * `deepseek.models.js` 只依赖 `model-catalog.js`（无 import）与一个 JSON，
 * 无任何 Node 内置模块，因此对浏览器打包安全。
 */

import type { Model } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";

/** 本项目当前只支持 openai-completions 协议的模型。 */
export type ChatModel = Model<"openai-completions">;

/** 全部可用的内置模型（来自 pi-ai 官方目录）。 */
export const CATALOG: ChatModel[] = Object.values(DEEPSEEK_MODELS);

/** 默认模型 id（0.86.0 起目录用 `deepseek-flash`，旧 `deepseek-v4-flash` 已退役）。 */
export const DEFAULT_MODEL_ID = "deepseek-flash";

/** 按 id 查找目录项。 */
export function findCatalogEntry(id: string): ChatModel | undefined {
  return CATALOG.find((model) => model.id === id);
}

/** 取默认目录项（找不到默认 id 时退化为目录第一项）。 */
export function defaultCatalogEntry(): ChatModel {
  return findCatalogEntry(DEFAULT_MODEL_ID) ?? CATALOG[0];
}
