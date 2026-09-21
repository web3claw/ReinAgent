/**
 * streamFnAdapter —— 把「provider 级 stream」适配成 pi-agent-core 需要的 `StreamFn`。
 *
 * 背景（S7-1，实测类型不兼容）：
 *   pi-agent-core 的 `AgentOptions.streamFn` 类型是
 *     type StreamFn = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions)
 *       => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
 *   它必须面对**任意 api**。而 provider 级 `stream`（如 `api/openai-completions` 的 `stream`、
 *   `providers/faux` 的 `stream`）已被窄化到某个具体 api：
 *     StreamFunction<"openai-completions", OpenAICompletionsOptions>
 *   于是把 provider 级 stream 直接赋给 StreamFn 会被 tsc 拒绝（**只有 model 这一个参数不兼容**，
 *   context / options / 返回类型都通过）：
 *
 *     TS2322: Type 'StreamFunction<"openai-completions", OpenAICompletionsOptions>' is not assignable
 *             to type 'StreamFn'. Types of parameters 'model' and 'model' are incompatible.
 *             Type 'Model<Api>' is not assignable to type 'Model<"openai-completions">'.
 *
 *   本模块在**唯一一处**完成这个收窄，并配**运行期守卫**兜底 ——
 *   绝不使用 `as` / `any` 把类型骗过去（那只是让 tsc 闭嘴，运行时照崩）。
 *
 * 与库的分工（务必遵守，否则会出错）：
 *   - pi-agent-core 在调用 streamFn 之前**已经**调过 `normalizeContext`；context 传进来时
 *     已是规范化的 `TranscriptContext`。⇒ 适配器**原样透传，绝不再调 normalizeContext**。
 *   - options 里库已装好 `apiKey`（由 `getApiKey` 解析）与 `signal`（库自建的 run signal）。
 *     ⇒ 适配器**不注入 apiKey、也不塞入外部 signal**。签名近乎纯粹的「收窄后转发」。
 *
 * 工厂形态的理由：faux 的 provider 级 stream 同样被窄化到 `Model<"faux">`，
 * 所以本适配器做成**工厂**（把 provider 级 stream 作为参数注入），
 * 让真实 DeepSeek 与 faux 走**同一条**适配路径，而不是各写一套。
 *
 * 类型声明见同目录 `streamFnAdapter.d.ts`；编译期形状证明见 `streamFnAdapter.types.ts`。
 */

/**
 * 创建一个满足 pi-agent-core `StreamFn` 形状的适配器。
 *
 * 返回的函数把 `(model, context, options)` **原样**转交给注入的 provider 级 stream：
 * 不做任何规范化、不改 options、不 await（返回值原样返回，允许是 Promise 或同步值）。
 * 唯一附加行为是**运行期 api 校验**：`model` 缺失或 `model.api !== api` 时抛出信息量足够的 Error。
 *
 * @param {object} options 工厂入参。
 * @param {(model: any, context: any, options?: any) => any} options.stream
 *   provider 级 stream 函数（真实为 `@earendil-works/pi-ai/api/openai-completions` 的 `stream`；
 *   测试里为 faux 的）。
 * @param {string} options.api
 *   该 provider 级 stream 期望的 api 字符串（如 `"openai-completions"`）。用于运行期校验。
 * @param {string} [options.label]
 *   出错信息里用于标识来源（如 `"deepseek"` / `"faux"`），便于排错。缺省时回退为 `options.api`。
 * @returns {(model: any, context: any, options?: any) => any} 满足 `StreamFn` 形状的函数。
 */
export function createStreamFnAdapter(options) {
  // 入参在此刻固化进闭包：两个工厂产出的适配器因此互不共享状态（无模块级可变变量）。
  const { stream, api, label } = options ?? {};

  if (typeof stream !== "function") {
    throw new TypeError(
      `createStreamFnAdapter: options.stream 必须是函数（label=${label ?? api ?? "(none)"}）`,
    );
  }
  if (typeof api !== "string" || api.length === 0) {
    throw new TypeError(
      `createStreamFnAdapter: options.api 必须是非空字符串（label=${label ?? "(none)"}）`,
    );
  }

  const sourceLabel = typeof label === "string" && label.length > 0 ? label : api;

  /**
   * 收窄后的转发：把「任意 api 的 model」收窄为「provider 级 stream 接受的 api」。
   * 这是类型收窄的**唯一**发生处；运行期守卫保证被收窄值确实满足前提。
   *
   * @param {any} model 库传入的模型（声明为 Model<Api>，此处收窄为具体 api）。
   * @param {any} context 库已规范化好的 TranscriptContext —— 原样透传。
   * @param {any} [options] 库装好的 SimpleStreamOptions（含 apiKey / signal）—— 原样透传。
   * @returns {any} provider 级 stream 的返回值（原样返回，不 await、不包装）。
   */
  return function streamFn(model, context, options) {
    // 守卫 1：model 必须存在且是对象。缺字段时不静默通过。
    if (model === null || typeof model !== "object") {
      throw new Error(
        `[${sourceLabel}] streamFnAdapter: model 缺失或非对象（实际：${
          model === null ? "null" : typeof model
        }）；期望 api="${api}"。`,
      );
    }

    // 守卫 2：model.api 必须与工厂期望一致。错误信息同时给出期望值与实际值，排错时一眼可辨。
    const actualApi = model.api;
    if (actualApi !== api) {
      throw new Error(
        `[${sourceLabel}] streamFnAdapter: model.api 不匹配 —— 期望 "${api}"，实际 ${JSON.stringify(
          actualApi,
        )}。该适配器只把 model 转交给 api="${api}" 的 provider 级 stream；` +
          `请检查「构造 Agent 使用的 model」与「绑定本适配器时的 api」是否一致。`,
      );
    }

    // 原样透传三件 —— 不规范化、不改 options、不 await。
    return stream(model, context, options);
  };
}
