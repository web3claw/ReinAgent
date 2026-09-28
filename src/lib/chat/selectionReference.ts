/**
 * selectionReference —— 选区引用存储与发送协议（P2-C1，对齐 ZCode
 * conversationSelectionReference 的核心语义）。
 *
 * - 引用按任务作用域存内存 Map（非持久化——会话刷新即清，与 ZCode 内存态一致）；
 * - 限额：单条 8000 字符、最多 8 条、总计 16000 字符，(taskId,text) 去重；
 * - 发送协议：composer 正文尾部追加 userselect 围栏块（JSON 数组，含可选 path），
 *   倒序解析契约的首块（ZCode composerPromptContexts 同形）。
 */

export interface SelectionReference {
  text: string;
  path?: string;
}

export const SELECTION_SINGLE_LIMIT_CHARS = 8_000;
export const SELECTION_MAX_ITEMS = 8;
export const SELECTION_TOTAL_LIMIT_CHARS = 16_000;

const referencesByTask = new Map<string, SelectionReference[]>();
const listeners = new Set<() => void>();

function notify(taskId: string) {
  for (const listener of listeners) listener();
  void taskId;
}

/** 订阅引用变化（composer chips 用；taskId 预留作用域过滤）。返回取消函数。 */
export function subscribeSelectionReferences(
  _taskId: string,
  listener: () => void,
): () => void {
  const wrapped = () => listener();
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

export function getSelectionReferences(taskId: string): SelectionReference[] {
  return referencesByTask.get(taskId) ?? [];
}

/** 添加选区引用；返回错误原因（null = 成功）。 */
export function addSelectionReference(
  taskId: string,
  reference: SelectionReference,
): "single-limit" | "max-items" | "total-limit" | "duplicate" | null {
  const text = reference.text.trim();
  if (!text) return "single-limit";
  if (text.length > SELECTION_SINGLE_LIMIT_CHARS) return "single-limit";
  const list = referencesByTask.get(taskId) ?? [];
  const dedupeKey = `${taskId}\0${text}`;
  for (const existing of list) {
    if (`${taskId}\0${existing.text}` === dedupeKey) return "duplicate";
  }
  if (list.length >= SELECTION_MAX_ITEMS) return "max-items";
  const total = list.reduce((sum, item) => sum + item.text.length, 0);
  if (total + text.length > SELECTION_TOTAL_LIMIT_CHARS) return "total-limit";
  list.push({ text, path: reference.path?.trim() || undefined });
  referencesByTask.set(taskId, list);
  notify(taskId);
  return null;
}

export function removeSelectionReference(taskId: string, index: number): void {
  const list = referencesByTask.get(taskId);
  if (!list || index < 0 || index >= list.length) return;
  list.splice(index, 1);
  if (list.length === 0) referencesByTask.delete(taskId);
  else referencesByTask.set(taskId, list);
  notify(taskId);
}

export function clearSelectionReferences(taskId: string): void {
  if (referencesByTask.delete(taskId)) notify(taskId);
}

/** 发送时把引用折叠成 userselect 尾块并拼在正文后（无引用时原样返回）。 */
export function buildPromptWithSelections(
  taskId: string,
  visibleContent: string,
): string {
  const references = getSelectionReferences(taskId);
  if (references.length === 0) return visibleContent;
  const block = [
    "# userselect:",
    "```userselect",
    JSON.stringify(
      references.map(({ text, path }) =>
        path?.trim() ? { path, text } : { text },
      ),
    ),
    "```",
  ].join("\n");
  const trimmed = visibleContent.trim();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/** 发送后清空该任务的引用（对齐 ZCode：发送即消费）。 */
export function consumeSelectionReferences(taskId: string): void {
  clearSelectionReferences(taskId);
}
