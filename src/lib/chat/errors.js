/**
 * errors —— 错误文案映射（纯函数）。
 *
 * ⚠ 与 `scripts/smoke.mjs` 的 `diagnose()` 的关系（如实描述，勿误以为是同一份实现）：
 *   - 本文件是**刻意为镜像 `scripts/smoke.mjs` 的 `diagnose()` 而存在的独立副本**，
 *     **不是**被 smoke.mjs import 的共享模块。`scripts/` 刻意不依赖 `src/`
 *     （开发期 CLI 不与应用源码耦合，避免方向别扭的依赖）。
 *   - **分类逻辑必须与 `scripts/smoke.mjs` 的 `diagnose()` 保持同步**：四个共有类别
 *     （401 / 402 / 429 / 网络）的**正则集合与分支顺序逐字节相同**，因此对同一个错误
 *     **落到同一分支**，分类行为等价。
 *   - **人读文案有意不同**：本模块面向 UI，去品牌化、语气贴合界面；
 *     smoke.mjs 面向命令行，会点名 DEEPSEEK_API_KEY / DeepSeek 服务。
 *   - 本模块额外多出「超时」分支（smoke.mjs 用独立的 `timedOut` 标记处理超时）
 *     与「请求失败」兜底串。
 *   - 改动任一方的分类分支时，请同步另一方。同步目标：`scripts/smoke.mjs` 的 `diagnose()`。
 *
 * 类型声明见同目录 `errors.d.ts`。
 */

/**
 * 把底层错误文本映射成可读中文提示。
 * 无法归类时返回带原始信息的兜底文案（绝不返回空串）。
 * @param {string|undefined|null} message
 * @returns {string}
 */
export function diagnoseError(message) {
  const m = message ?? "";

  // 四类共有判定：正则集合与分支顺序与 `scripts/smoke.mjs` 的 diagnose() 保持同步
  // （分类行为等价，但人读文案不同 —— 见文件头说明）。
  if (/401|unauthor|invalid api key|authentication|api key not valid/i.test(m)) {
    return "鉴权失败（401）：API Key 无效或已过期，请在设置中检查。";
  }
  if (/402|insufficient|balance|quota/i.test(m)) {
    return "额度不足（402）：账户余额或用量已用尽，请充值后重试。";
  }
  if (/429|rate limit|too many requests/i.test(m)) {
    return "请求过于频繁（429）：请稍后重试。";
  }
  if (/502|503|504|bad gateway|service unavailable|failed to forward/i.test(m)) {
    return "服务暂时不可用（5xx）：上游服务无响应或转发失败，请稍后重试。";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|failed to fetch|socket hang up|network|connection error/i.test(m)) {
    return "网络错误：连接中断或无法连接服务，请检查网络或代理设置。";
  }
  // 补充：超时（smoke.mjs 用 timedOut 标记，UI 侧按文本判定）。
  if (/timeout|timed out|超时/i.test(m)) {
    return "请求超时：服务长时间未响应，请稍后重试。";
  }

  const trimmed = m.trim();
  return `请求失败：${trimmed.length > 0 ? trimmed : "未知错误"}`;
}

/**
 * 判断一个 error 终止是否为「用户主动中止」。
 * pi-ai 以 `error` 事件下发中止，且 `reason === "aborted"`；这与真正的错误必须区分开。
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isAbortReason(reason) {
  return reason === "aborted";
}

/**
 * 判断一个错误是否值得自动重试（网络抖动 / 网关 5xx / 超时）。
 * 401/402/429 等确定性失败不重试（重试也不会成功）。
 * @param {string|undefined|null} message
 * @returns {boolean}
 */
export function isRetryableError(message) {
  const m = message ?? "";
  return (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|failed to fetch|socket hang up|network|connection error|timeout|timed out|超时/i.test(m) ||
    /502|503|504|bad gateway|service unavailable|failed to forward/i.test(m) ||
    // 对齐 LiveAgent 重试预设：429/500/524 + Cloudflare 520-527
    /(^|\D)(429|500|524|52[0-7])(\D|$)/.test(m)
  );
}
