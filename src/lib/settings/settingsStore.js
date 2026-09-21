/**
 * settingsStore —— 设置持久化的**纯**抽象层（可注入后端，可无头测试）。
 *
 * 设计目标（S3 硬要求）：
 *   - **优雅降级**：后端（plugin-store）不可用时，退化为内存实现，并给出
 *     明确警示；**绝不抛异常、绝不静默丢配置**。
 *   - **可注入**：读写后端以 `{ read, write }` 注入。Tauri 环境注入 plugin-store；
 *     纯浏览器/Node 环境注入内存或抛错后端。这样本模块能被 `node --test` 直接验证。
 *
 * 本文件为纯逻辑（无 React / 无 DOM / 无全局副作用）。
 * 类型声明见同目录 `settingsStore.d.ts`。
 */

/**
 * 把任意读入值收敛为合法设置对象：
 * - 非对象 → 视为空；
 * - 只保留已知键（apiKey / modelId / baseUrl）；
 * - 缺失或类型不符的键补 `defaults`；
 * - **apiKey 做 trim**：从网页/文档复制来的 Key 常带前后空白，若不清理会原样
 *   进入请求头 → 必然 401，用户会误以为 Key 填错。trim 同时作用于持久化与读取两侧，
 *   因此全空白会被归一化为 `""`，让上层稳定地判定为「演示模式」（不会去发注定 401 的请求）。
 *
 * @param {unknown} raw
 * @param {{apiKey:string, modelId:string, baseUrl:string}} defaults
 * @returns {{apiKey:string, modelId:string, baseUrl:string}}
 */
export function normalizeSettings(raw, defaults) {
  const source = raw !== null && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const pick = (key) => (typeof source[key] === "string" ? /** @type {string} */ (source[key]) : defaults[key]);
  return {
    apiKey: pick("apiKey").trim(),
    modelId: pick("modelId"),
    baseUrl: pick("baseUrl"),
  };
}

/**
 * 创建一个设置存储。
 *
 * @param {{
 *   read: () => Promise<unknown>,
 *   write: (value: {apiKey:string, modelId:string, baseUrl:string}) => Promise<unknown>,
 *   defaults: {apiKey:string, modelId:string, baseUrl:string},
 *   warn?: (message: string) => void,
 * }} options
 * @returns {{
 *   readonly degraded: boolean,
 *   readonly warning: (string|null),
 *   readonly backendKind: ("persistent"|"memory"),
 *   load: () => Promise<{apiKey:string, modelId:string, baseUrl:string}>,
 *   save: (patch: Partial<{apiKey:string, modelId:string, baseUrl:string}>) => Promise<boolean>,
 *   snapshot: () => {apiKey:string, modelId:string, baseUrl:string},
 * }}
 */
export function createSettingsStore(options) {
  const { read, write, defaults, warn } = options;
  const base = { ...defaults };

  let cache = { ...base };
  let degraded = false;
  let warning = null;

  /** 首次降级时记录警示（只记一次并只回调一次 warn，避免刷屏）。 */
  const flagWarning = (message) => {
    degraded = true;
    if (warning === null) {
      warning = message;
      if (typeof warn === "function") warn(message);
    }
  };

  return {
    get degraded() {
      return degraded;
    },
    get warning() {
      return warning;
    },
    get backendKind() {
      return degraded ? "memory" : "persistent";
    },

    /** 读取设置；读失败 → 降级为内存 + 警示，返回默认值。 */
    async load() {
      try {
        const raw = await read();
        cache = normalizeSettings(raw, base);
      } catch (err) {
        flagWarning(
          `设置持久化不可用，已退化为内存模式（本次运行的修改在重启后会丢失）：${err?.message ?? err}`,
        );
        cache = { ...base };
      }
      return { ...cache };
    },

    /** 写入设置；写失败 → 保留内存值 + 警示，返回 false。 */
    async save(patch) {
      cache = normalizeSettings({ ...cache, ...patch }, base);
      try {
        await write({ ...cache });
        return true;
      } catch (err) {
        flagWarning(`设置保存失败，本次仅保留在内存中（重启后会丢失）：${err?.message ?? err}`);
        return false;
      }
    },

    /** 不触发 I/O 的当前值快照。 */
    snapshot() {
      return { ...cache };
    },
  };
}
