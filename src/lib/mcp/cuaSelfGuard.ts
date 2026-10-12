import { invoke } from "@tauri-apps/api/core";

/**
 * 把 ReinAgent 自己从 cua-driver 的视野与可操作范围里摘掉。
 *
 * 为什么需要：cua-driver 看到的是整个桌面，其中包括 ReinAgent 自己的窗
 * 口。让模型操作宿主界面是危险的自指——它能点掉自己的审批弹窗（等于绕过
 * 审批）、改自己的权限策略、或者直接把自己关了。上游没有「排除某个 app」
 * 的机制，所以这道闸只能开在宿主侧。
 *
 * 四条路径都要拦：
 * - 按 pid / window_id 寻址：递归扫描整个入参。
 * - 按屏幕坐标寻址：坐标和宿主窗口的实际矩形比对。
 * - 无目标的键盘输入：检查当前前台应用。
 * - 出参：list_windows / list_apps 等剔除宿主记录，顺手动态学习宿主的 window_id。
 */

const SELF_TARGET_REFUSAL =
  "该目标是 ReinAgent 自身的窗口，已被拒绝：让模型操作宿主界面可以绕过工具审批、" +
  "改写权限设置或直接关闭应用。请改为操作其他应用。（如确需自动化 ReinAgent 本身，" +
  "在「设置 → Computer Use」中打开「允许操作 ReinAgent 自身」。）";

const SELF_REGION_REFUSAL =
  "该坐标落在 ReinAgent 自身的窗口范围内，已被拒绝：以桌面为目标按屏幕坐标操作宿主界面，" +
  "同样可以点掉审批弹窗或改写权限设置。请改为操作其他应用的窗口。（如确需自动化 ReinAgent " +
  "本身，在「设置 → Computer Use」中打开「允许操作 ReinAgent 自身」。）";

const SELF_FOREGROUND_REFUSAL =
  "ReinAgent 当前是前台应用，这次无明确目标的桌面键盘输入会直接落在宿主界面上" +
  "（可以按掉审批弹窗、用快捷键关闭应用），已被拒绝。请先聚焦目标应用（例如先点击它的窗口），" +
  "或改用带 pid / window_id 的显式窗口目标。（如确需自动化 ReinAgent 本身，" +
  "在「设置 → Computer Use」中打开「允许操作 ReinAgent 自身」。）";

const SELF_FOREGROUND_UNKNOWN_REFUSAL =
  "无法确认当前前台应用，已拒绝这次无明确目标的桌面键盘输入：确认不了它不会落在 ReinAgent " +
  "自己身上。请改用带 pid / window_id 的显式窗口目标，或稍后重试。";

const SELF_SCAN_DEPTH_REFUSAL =
  "调用参数的嵌套层级超出了安全检查的上限，已被拒绝：无法确认它是否以 ReinAgent 自身为目标。" +
  "请用扁平一些的参数重试。";

type SelfIdentity = { pid: number };

export type SelfWindowRect = { x: number; y: number; width: number; height: number };

let selfPidPromise: Promise<number | null> | null = null;

async function loadSelfPid(): Promise<number | null> {
  if (selfPidPromise) {
    const cached = await selfPidPromise;
    if (cached !== null) return cached;
  }
  const attempt = invoke<SelfIdentity>("cua_driver_self_identity")
    .then((identity) => readNumber(identity?.pid))
    .catch(() => null);
  selfPidPromise = attempt;
  return attempt;
}

const SELF_RECTS_TTL_MS = 400;

let selfRectsCache: { at: number; rects: SelfWindowRect[] } | null = null;

async function loadSelfWindowRects(): Promise<SelfWindowRect[]> {
  if (selfRectsCache && Date.now() - selfRectsCache.at <= SELF_RECTS_TTL_MS) {
    return selfRectsCache.rects;
  }
  const rects = await invoke<SelfWindowRect[]>("cua_driver_self_windows").catch(() => []);
  selfRectsCache = { at: Date.now(), rects: Array.isArray(rects) ? rects : [] };
  return selfRectsCache.rects;
}

async function loadFrontmostPid(): Promise<number | null> {
  try {
    return readNumber(await invoke<number>("cua_driver_frontmost_pid"));
  } catch {
    return null;
  }
}

const learnedSelfWindowIds = new Set<number>();

const MAX_SCAN_DEPTH = 12;

const PID_KEYS = ["pid", "process_id", "processId", "owner_pid", "ownerPid"] as const;

const WINDOW_ID_KEYS = ["window_id", "windowId"] as const;

const SCOPED_TARGET_KINDS = new Set(["window", "app", "application", "element"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type ScanResult = "hit" | "truncated" | "clear";

function scanRecords(
  node: unknown,
  visit: (record: Record<string, unknown>) => boolean,
  depth = 0,
): ScanResult {
  if (depth > MAX_SCAN_DEPTH) return "truncated";

  const children = Array.isArray(node) ? node : null;
  if (!children) {
    const record = asRecord(node);
    if (!record) return "clear";
    if (visit(record)) return "hit";
    return scanChildren(Object.values(record), visit, depth);
  }
  return scanChildren(children, visit, depth);
}

function scanChildren(
  values: unknown[],
  visit: (record: Record<string, unknown>) => boolean,
  depth: number,
): ScanResult {
  let truncated = false;
  for (const value of values) {
    const result = scanRecords(value, visit, depth + 1);
    if (result === "hit") return "hit";
    if (result === "truncated") truncated = true;
  }
  return truncated ? "truncated" : "clear";
}

export function refuseSelfTargetedCall(
  args: Record<string, unknown> | undefined,
  selfPid: number | null,
): string | null {
  if (!args) return null;

  const result = scanRecords(args, (record) => {
    if (selfPid !== null && PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) {
      return true;
    }
    return WINDOW_ID_KEYS.some((key) => {
      const windowId = readNumber(record[key]);
      return windowId !== null && learnedSelfWindowIds.has(windowId);
    });
  });

  if (result === "hit") return SELF_TARGET_REFUSAL;
  if (result === "truncated") return SELF_SCAN_DEPTH_REFUSAL;
  return null;
}

export function usesDesktopScreenCoordinates(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;

  let scoped = false;
  scanRecords(args, (record) => {
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : null;
    if (kind && SCOPED_TARGET_KINDS.has(kind)) {
      scoped = true;
      return true;
    }
    return false;
  });
  if (scoped) return false;

  return collectScreenPoints(args).length > 0;
}

function collectScreenPoints(args: Record<string, unknown>): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  scanRecords(args, (record) => {
    const x = readNumber(record.x);
    const y = readNumber(record.y);
    if (x !== null && y !== null) points.push({ x, y });
    return false;
  });
  return points;
}

function pointInRect(point: { x: number; y: number }, rect: SelfWindowRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function refuseSelfRegionCall(
  args: Record<string, unknown> | undefined,
  rects: SelfWindowRect[],
): string | null {
  if (!args || rects.length === 0) return null;
  const points = collectScreenPoints(args);
  const hit = points.some((point) => rects.some((rect) => pointInRect(point, rect)));
  return hit ? SELF_REGION_REFUSAL : null;
}

const FOCUS_DELIVERY_TOOLS = new Set(["type_text", "press_key", "hotkey"]);

export function isDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  const name = toolName.trim().toLowerCase();
  const byName = FOCUS_DELIVERY_TOOLS.has(name);
  const byShape =
    !byName &&
    args !== undefined &&
    scanRecords(args, (record) => {
      if (typeof record.key === "string") return true;
      return Array.isArray(record.keys) && record.keys.some((k) => typeof k === "string");
    }) === "hit";
  if (!byName && !byShape) return false;

  const identified =
    args !== undefined &&
    scanRecords(args, (record) =>
      [...PID_KEYS, ...WINDOW_ID_KEYS].some((key) => readNumber(record[key]) !== null),
    ) === "hit";
  return !identified;
}

export function refuseDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  selfPid: number,
  frontmostPid: number | null,
): string | null {
  if (!isDesktopKeyboardCall(toolName, args)) return null;
  if (frontmostPid === null) return SELF_FOREGROUND_UNKNOWN_REFUSAL;
  return frontmostPid === selfPid ? SELF_FOREGROUND_REFUSAL : null;
}

function findJsonSpan(text: string, from = 0): { start: number; end: number } | null {
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char !== "{" && char !== "[") continue;

    const closing = char === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const current = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') {
        inString = true;
        continue;
      }
      if (current === char) depth++;
      else if (current === closing) {
        depth--;
        if (depth === 0) return { start: i, end: j + 1 };
      }
    }
    return null;
  }
  return null;
}

export function stripSelfFromJsonText(text: string, selfPid: number | null): string {
  if (selfPid === null) return text;

  let out = "";
  let cursor = 0;
  let changedAny = false;

  for (let span = findJsonSpan(text, cursor); span; span = findJsonSpan(text, cursor)) {
    const raw = text.slice(span.start, span.end);
    const stripped = stripSelfFromJsonValue(raw, selfPid);
    out += text.slice(cursor, span.start) + (stripped ?? raw);
    if (stripped !== null) changedAny = true;
    cursor = span.end;
  }

  if (!changedAny) return text;
  return out + text.slice(cursor);
}

function stripSelfFromJsonValue(raw: string, selfPid: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  let changed = false;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const kept = node.filter((entry) => {
        const record = asRecord(entry);
        if (!record) return true;
        if (!PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) return true;
        for (const key of WINDOW_ID_KEYS) {
          const windowId = readNumber(record[key]);
          if (windowId !== null) learnedSelfWindowIds.add(windowId);
        }
        changed = true;
        return false;
      });
      return kept.map(visit);
    }
    const record = asRecord(node);
    if (!record) return node;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) next[key] = visit(value);
    return next;
  };

  const result = visit(parsed);
  return changed ? JSON.stringify(result) : null;
}

export function resetCuaSelfGuardCaches() {
  selfPidPromise = null;
  selfRectsCache = null;
  learnedSelfWindowIds.clear();
}

export type CuaSelfGuard = {
  refuse: (toolName: string, args: Record<string, unknown> | undefined) => Promise<string | null>;
  strip: (text: string) => string;
};

export async function resolveCuaSelfGuard(
  allowSelfTargeting: boolean,
): Promise<CuaSelfGuard | null> {
  if (allowSelfTargeting) return null;
  const selfPid = await loadSelfPid();
  if (selfPid === null) return null;
  return {
    refuse: async (toolName, args) => {
      const targeted = refuseSelfTargetedCall(args, selfPid);
      if (targeted) return targeted;
      if (isDesktopKeyboardCall(toolName, args)) {
        const keyboard = refuseDesktopKeyboardCall(
          toolName,
          args,
          selfPid,
          await loadFrontmostPid(),
        );
        if (keyboard) return keyboard;
      }
      if (!usesDesktopScreenCoordinates(args)) return null;
      return refuseSelfRegionCall(args, await loadSelfWindowRects());
    },
    strip: (text) => stripSelfFromJsonText(text, selfPid),
  };
}

export const CUA_SELF_TARGET_REFUSAL = SELF_TARGET_REFUSAL;
export const CUA_SELF_REGION_REFUSAL = SELF_REGION_REFUSAL;
export const CUA_SELF_SCAN_DEPTH_REFUSAL = SELF_SCAN_DEPTH_REFUSAL;
export const CUA_SELF_FOREGROUND_REFUSAL = SELF_FOREGROUND_REFUSAL;
export const CUA_SELF_FOREGROUND_UNKNOWN_REFUSAL = SELF_FOREGROUND_UNKNOWN_REFUSAL;
