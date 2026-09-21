/**
 * settingsStore —— 设置持久化的纯抽象层。
 */

export function normalizeSettings(raw, defaults) {
  const source = raw !== null && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const pick = (key) => (typeof source[key] === "string" ? /** @type {string} */ (source[key]) : defaults[key]);
  const res = {
    apiKey: pick("apiKey").trim(),
    modelId: pick("modelId"),
    baseUrl: pick("baseUrl"),
  };
  if ("provider" in defaults || "provider" in source) {
    res.provider = pick("provider");
  }
  return res;
}

export function createSettingsStore(options) {
  const { read, write, defaults, warn } = options;
  const base = { ...defaults };

  let cache = { ...base };
  let degraded = false;
  let warning = null;

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

    snapshot() {
      return { ...cache };
    },
  };
}
