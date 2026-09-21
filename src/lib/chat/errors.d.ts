/**
 * errors 的类型声明（实现见同目录 `errors.js`）。
 */

export function diagnoseError(message: string | undefined | null): string;

export function isAbortReason(reason: unknown): boolean;
