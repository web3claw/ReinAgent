/**
 * PendingRecoveryBanner —— 重载后「未完成审批/提问」的恢复横幅（2026-10-06 用户定稿完整版）。
 *
 * 数据源：挂起时经 controller 钩子持久化的 kv（reinagent-pending-approval:<taskId>），
 * App 在任务激活时读取并注入本组件。
 *
 * 两种形态：
 * - **提问**：[继续处理] 展开重放的 AskQuestionCard（题目来自持久化 args），提交/跳过 →
 *   组合续接用户消息走正常发送（模型从未见过原提问，消息里如实重述问题与回答）；
 * - **审批**：横幅直接给 [允许并继续]（当场真实执行该工具并把结果组合进续接消息）与
 *   [拒绝]（告知模型请求被拒）；[忽略] 仅清除横幅与持久化。
 *
 * 执行失败也如实组合进消息（模型自行调整），绝不静默。
 */

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { PendingApproval } from "../../lib/chat/conversationModel";
import { questionsOf } from "../../lib/chat/pendingRecovery";
import { AskQuestionCard } from "./AskQuestionCard";
import { useTranslation } from "../../i18n";

export interface PendingRecoveryBannerProps {
  recovery: PendingApproval;
  /** 忽略（清除持久化，不发任何消息） */
  onDismiss: () => void;
  /** 提问重放：用户提交回答（App 层组合续接消息后走正常发送） */
  onAnswer: (answers: { question: string; answer: string }[]) => void;
  /** 审批拒绝（App 层组合拒绝消息后走正常发送） */
  onReject: () => void;
  /** 审批允许（App 层代为执行并组合结果消息后走正常发送） */
  onAllow: () => void;
  busy?: boolean;
}

export function PendingRecoveryBanner({ recovery, onDismiss, onAnswer, onReject, onAllow, busy = false }: PendingRecoveryBannerProps) {
  const { t } = useTranslation();
  const isQuestion = (recovery.args as { kind?: string } | undefined)?.kind === "question";
  const questions = isQuestion ? questionsOf(recovery) : [];
  const [expanded, setExpanded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const bannerLabel = isQuestion
    ? t("pendingRecoveryBannerQuestion")
    : t("pendingRecoveryBannerApproval").replace("{tool}", recovery.toolName);

  const dismiss = () => {
    onDismiss();
  };

  const handleContinue = () => {
    if (isQuestion) {
      setExpanded(true);
      return;
    }
    // 审批：允许 → App 层代为真实执行并组合结果续接
    onAllow();
  };

  const handleReject = () => {
    onReject();
  };

  const handleAnswer = (answers: { question: string; answer: string }[]) => {
    onAnswer(answers);
  };

  return (
    <div className="flex flex-col gap-1.5 px-4 py-2 text-xs bg-[var(--warn-bg)] border-b border-[var(--warn-border)] text-[var(--warn-text)] flex-shrink-0">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="font-medium">{bannerLabel}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleContinue}
            className="rounded-lg border border-[var(--warn-border)] px-3 py-1 font-medium hover:opacity-85 disabled:opacity-50"
          >
            {isQuestion
              ? t("pendingRecoveryContinue")
              : t("pendingRecoveryAllow")}
          </button>
          {!isQuestion ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleReject}
              className="rounded-lg px-3 py-1 hover:opacity-85 disabled:opacity-50"
            >
              {t("pendingRecoveryReject")}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={dismiss}
            className="rounded-lg px-2 py-1 text-[var(--warn-text)]/80 hover:text-[var(--warn-text)] disabled:opacity-50"
          >
            {t("pendingRecoveryDismiss")}
          </button>
        </div>
      </div>
      {isQuestion && expanded ? (
        <div className="rounded-lg border border-[var(--warn-border)] bg-[var(--bg)] p-2">
          <AskQuestionCard
            questions={questions as never}
            onAnswer={handleAnswer}
            onSkip={() => {
              setExpanded(false);
              dismiss();
            }}
            onMinimize={() => setExpanded(false)}
            activeIndex={activeIndex}
            onActiveIndexChange={setActiveIndex}
          />
        </div>
      ) : null}
    </div>
  );
}
