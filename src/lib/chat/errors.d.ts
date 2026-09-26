/**
 * errors 的类型声明（实现见同目录 `errors.js`）。
 */

export function diagnoseError(message: string | undefined | null): string;

export function isAbortReason(reason: unknown): boolean;

/** 判断一个错误是否值得自动重试（网络 / 5xx / 超时）。 */
export function isRetryableError(message: string | undefined | null): boolean;
