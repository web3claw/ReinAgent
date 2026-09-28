/**
 * AskQuestionCard —— 回合内提问卡（对齐 LiveAgent AskUserQuestionCard 最小可用版）。
 *
 * 渲染条件：`state.pendingApproval.args.kind === "question"`（ask_user_question 工具挂起）。
 * 形态：标题「提问」+ 逐题单选（推荐项绿标）+「其他」自由输入 + 底部提交；
 * 提交 → resolveApproval(taskId, { answers }) → 工具收敛、模型继续。
 *
 * ZCode/LiveAgent 的翻页（1/N）与倒计时自动收敛属增强项，本版单页全列（题目少时等价）。
 */

import { useMemo, useState } from "react";
import { HelpCircle } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { AskUserQuestion } from "../../lib/agent/askUserTool";

export interface AskQuestionCardProps {
  questions: AskUserQuestion[];
  /** 提交回答（App 层透传 poolResolveApproval 的结构化值） */
  onAnswer: (answers: Array<{ question: string; answer: string }>) => void;
  /** 跳过（工具收到 skip 提示后收敛） */
  onSkip: () => void;
}

interface DraftAnswer {
  selected?: string;
  custom?: string;
}

export function AskQuestionCard({ questions, onAnswer, onSkip }: AskQuestionCardProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<number, DraftAnswer>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setDraft = (index: number, patch: DraftAnswer) => {
    setDrafts((cur) => ({ ...cur, [index]: { ...cur[index], ...patch } }));
  };

  const allAnswered = useMemo(
    () => questions.every((_q, i) => (drafts[i]?.selected ?? drafts[i]?.custom ?? "").length > 0),
    [questions, drafts],
  );

  const submit = () => {
    const answers: Array<{ question: string; answer: string }> = [];
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      const draft = drafts[i] ?? {};
      const answer = draft.custom?.trim() || draft.selected || "";
      if (!answer) {
        setSubmitError(t("askQuestionIncomplete"));
        return;
      }
      answers.push({ question: q.question, answer });
    }
    onAnswer(answers);
  };

  return (
    <div
      className="mb-2 w-full rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] p-4 text-sm shadow-lg"
      role="dialog"
      aria-label={t("askQuestionTitle")}
    >
      <div className="mb-3 flex items-center gap-2 font-medium text-[var(--text)]">
        <HelpCircle className="w-4 h-4 text-[var(--brand)]" />
        <span>{t("askQuestionTitle")}</span>
      </div>

      <div className="space-y-4">
        {questions.map((q, qi) => {
          const recommended = q.options.find((o) => o.recommended);
          const draft = drafts[qi] ?? {};
          return (
            <div key={qi} className="rounded-lg border border-[var(--border)] p-3">
              <div className="mb-2 font-medium text-[var(--text)]">{q.question}</div>
              <div className="space-y-1.5">
                {q.options.map((option) => {
                  const isSelected = draft.selected === option.label;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => setDraft(qi, { selected: option.label, custom: undefined })}
                      className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                        isSelected
                          ? "border-[var(--brand)] bg-[var(--brand-dim)]"
                          : "border-[var(--border)] hover:border-[var(--brand)] hover:bg-[var(--surface-hover)]"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                          isSelected ? "border-[var(--brand)]" : "border-[var(--text-dim)]"
                        }`}
                      >
                        {isSelected ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
                        ) : null}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
                          {option.label}
                          {option.recommended ? (
                            <span className="rounded bg-[var(--status-ok)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-ok)]">
                              {t("askOptionRecommended")}
                            </span>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block text-xs text-[var(--text-dim)]">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {q.allowCustom !== false ? (
                <input
                  type="text"
                  value={draft.custom ?? ""}
                  onChange={(e) => setDraft(qi, { custom: e.target.value, selected: undefined })}
                  placeholder={t("askCustomPlaceholder")}
                  className="mt-2 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
                />
              ) : null}
              {!q.options.some((o) => o.recommended) && recommended ? null : null}
            </div>
          );
        })}
      </div>

      {submitError ? (
        <div className="mt-2 text-xs text-[var(--danger)]">{submitError}</div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
        >
          {t("askSkip")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered}
          className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("askSubmit")}
        </button>
      </div>
    </div>
  );
}
