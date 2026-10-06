/**
 * AskQuestionCard —— 回合内提问卡（对齐 LiveAgent AskUserQuestionCard；2026-10-06 用户定稿改版）。
 *
 * 渲染条件：`state.pendingApproval.args.kind === "question"`（ask_user_question 工具挂起）。
 * 形态（单弹窗多 Tab）：
 * - 无标题行；顶部 Tab 条 = 每个问题一个 Tab（标签 = 题目文本，已答题带绿点）；
 * - 当前 Tab 下方只显示该题的选项列表 +「其他」自由输入；Tab / 下个问题自由切换（草稿保留）；
 *   **选中选项即自动跳下一题**（最后一题不跳、不自动提交；自由输入不触发跳题）；
 * - 右下角：非最后 Tab =「下个问题」，最后 Tab =「提交回答」（未答齐禁用，提交校验报错并跳到第一个未答的题）；
 *   左下角「跳过」语义不变（整体跳过 = reject）；
 * - 右上角缩小按钮：经 onMinimize 交给 App 收起为输入框右上方的胶囊（点击恢复，草稿不丢）。
 */

import { useMemo, useState } from "react";
import { Check, HelpCircle, Minus } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { AskUserQuestion } from "../../lib/agent/askUserTool";

export interface AskQuestionCardProps {
  questions: AskUserQuestion[];
  /** 提交回答（App 层透传 poolResolveApproval 的结构化值） */
  onAnswer: (answers: Array<{ question: string; answer: string }>) => void;
  /** 跳过（工具收到 skip 提示后收敛） */
  onSkip: () => void;
  /** 缩小到输入框右上方胶囊（App 层持 minimized 状态并渲染胶囊） */
  onMinimize: () => void;
  /** 当前 Tab 索引（受控，提升到 App：缩小胶囊要显示当前题文本，且缩小恢复后停留在原 Tab） */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

interface DraftAnswer {
  selected?: string;
  custom?: string;
}

export function AskQuestionCard({
  questions,
  onAnswer,
  onSkip,
  onMinimize,
  activeIndex,
  onActiveIndexChange,
}: AskQuestionCardProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<number, DraftAnswer>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const active = Math.min(Math.max(activeIndex, 0), questions.length - 1);

  const setDraft = (index: number, patch: DraftAnswer) => {
    setDrafts((cur) => ({ ...cur, [index]: { ...cur[index], ...patch } }));
  };

  /** 该题是否已有答案（选项或自由输入任一非空）。 */
  const isAnswered = (index: number) =>
    (drafts[index]?.selected ?? drafts[index]?.custom ?? "").length > 0;

  const allAnswered = useMemo(
    () => questions.every((_q, i) => isAnswered(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isAnswered 只依赖 drafts 与 questions
    [questions, drafts],
  );

  const gotoTab = (index: number) => {
    onActiveIndexChange(index);
    setSubmitError(null);
  };

  const submit = () => {
    const answers: Array<{ question: string; answer: string }> = [];
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      const draft = drafts[i] ?? {};
      const answer = draft.custom?.trim() || draft.selected || "";
      if (!answer) {
        setSubmitError(t("askQuestionIncomplete"));
        gotoTab(i); // 跳到第一个未答的题
        return;
      }
      answers.push({ question: q.question, answer });
    }
    onAnswer(answers);
  };

  const q = questions[active];
  const isLast = active === questions.length - 1;

  return (
    <div
      className="relative mb-2 w-full rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] p-4 text-sm shadow-lg"
      role="dialog"
      aria-label={t("askQuestionTitle")}
    >
      {/* 右上角缩小按钮（用户定稿 2026-10-06）：收起为输入框右上方胶囊 */}
      <button
        type="button"
        onClick={onMinimize}
        title={t("askMinimize")}
        aria-label={t("askMinimize")}
        className="absolute right-2 top-2 rounded p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <Minus className="size-3.5" />
      </button>

      {/* Tab 条：每个问题一个 Tab（标签 = 题目文本；已答带绿点） */}
      <div className="mb-3 flex gap-1 overflow-x-auto pr-8" role="tablist">
        {questions.map((question, qi) => (
          <button
            key={qi}
            type="button"
            role="tab"
            aria-selected={qi === active}
            onClick={() => gotoTab(qi)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              qi === active
                ? "border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--brand)] hover:text-[var(--text)]"
            }`}
          >
            <span className="max-w-48 truncate">{question.question}</span>
            {isAnswered(qi) ? (
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--status-ok)]/15">
                <Check className="size-2.5 text-[var(--status-ok)]" />
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* 当前题内容 */}
      <div className="rounded-lg border border-[var(--border)] p-3" role="tabpanel">
        <div className="mb-2 font-medium text-[var(--text)]">{q.question}</div>
        <div className="space-y-1.5">
          {q.options.map((option) => {
            const isSelected = drafts[active]?.selected === option.label;
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  setDraft(active, { selected: option.label, custom: undefined });
                  // 用户定稿 2026-10-06：选中即自动跳下一题；最后一题不跳也不自动提交
                  //（自由输入不触发——打字过程跳题会打断输入）
                  if (active < questions.length - 1) gotoTab(active + 1);
                }}
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
            value={drafts[active]?.custom ?? ""}
            onChange={(e) => setDraft(active, { custom: e.target.value, selected: undefined })}
            placeholder={t("askCustomPlaceholder")}
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
          />
        ) : null}
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
        {isLast ? (
          <button
            type="button"
            onClick={submit}
            disabled={!allAnswered}
            className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("askSubmit")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => gotoTab(active + 1)}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--brand)]"
          >
            {t("askNextQuestion")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 最小化胶囊（输入框右上方；显示当前 Tab 正在回答的问题，点击恢复弹窗）——App 层渲染。 */
export function AskQuestionMinimizedPill({
  question,
  count,
  onRestore,
}: {
  question: string;
  count: number;
  onRestore: () => void;
}) {
  return (
    <div className="mb-1.5 flex justify-end">
      <button
        type="button"
        onClick={onRestore}
        title={question}
        className="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs transition-colors hover:border-[var(--brand)]"
      >
        <HelpCircle className="size-3.5 shrink-0 text-[var(--brand)]" />
        <span className="min-w-0 truncate text-[var(--text)]">{question}</span>
        {count > 1 ? (
          <span className="shrink-0 rounded-full bg-[var(--brand-dim)] px-1.5 text-[10px] font-medium text-[var(--brand)]">
            {count}
          </span>
        ) : null}
      </button>
    </div>
  );
}
