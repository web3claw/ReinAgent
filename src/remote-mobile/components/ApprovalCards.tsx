/**
 * ApprovalCards —— 手机端审批 / 提问 / 计划卡（桌面 ApprovalCard/AskQuestionCard/PlanModeCard 的
 * 移动形态）。决策协议与桌面完全一致：
 * - 审批："allow" | "always" | "reject"
 * - 提问：{ answers: [{question, answer}] }；跳过 "reject"
 * - 计划：{ approved: true }（桌面桥侧先切 ask 模式再 resolve）/ { approved: false, feedback }
 */
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Minus, ShieldAlert } from "lucide-react";
import type { PendingApprovalPayload } from "../api/protocol";
import { MobileMarkdown } from "./MobileMarkdown";
import { useRemoteT } from "../i18n";
import { cn } from "../lib/cn";

interface QuestionItem {
  question?: string;
  options?: string[];
  recommended?: string;
  multiSelect?: boolean;
}

export function RemoteApprovalCard({
  pending,
  onDecide,
}: {
  pending: PendingApprovalPayload;
  onDecide: (decision: "allow" | "always" | "reject") => void;
}) {
  const t = useRemoteT();
  return (
    <div className="mx-3 mb-2 rounded-xl border border-warning/50 bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-warning" />
        <span className="text-ui-sm font-medium text-foreground">
          {t("approvalRequiredBadge")}
        </span>
      </div>
      <div className="mt-2 rounded-lg bg-surface px-2.5 py-2">
        <div className="text-ui-sm font-medium text-foreground">{pending.toolName}</div>
        <pre className="no-scrollbar mt-1 max-h-40 overflow-auto font-mono text-ui-xs break-all whitespace-pre-wrap text-foreground-subtle">
          {JSON.stringify(pending.args ?? {}, null, 2)}
        </pre>
      </div>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          className="h-9 flex-1 rounded-lg bg-destructive text-ui-sm font-medium text-destructive-foreground active:opacity-80"
          onClick={() => onDecide("reject")}
        >
          {t("approvalReject")}
        </button>
        <button
          type="button"
          className="h-9 flex-1 rounded-lg border border-border bg-surface text-ui-sm font-medium text-foreground active:opacity-80"
          onClick={() => onDecide("always")}
        >
          {t("approvalAllowAlways")}
        </button>
        <button
          type="button"
          className="h-9 flex-1 rounded-lg bg-brand text-ui-sm font-medium text-white active:opacity-80"
          onClick={() => onDecide("allow")}
        >
          {t("approvalAllow")}
        </button>
      </div>
    </div>
  );
}

export function RemoteQuestionCard({
  pending,
  onAnswer,
  onSkip,
}: {
  pending: PendingApprovalPayload;
  onAnswer: (answers: { question: string; answer: string }[]) => void;
  onSkip: () => void;
}) {
  const t = useRemoteT();
  const questions = ((pending.args?.questions ?? []) as QuestionItem[]).filter(
    (q) => typeof q?.question === "string",
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});
  const current = questions[activeIndex];
  const answeredCount = questions.filter((_, i) => answers[i]).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;

  if (!current) return null;

  const selectOption = (option: string) => {
    setAnswers((prev) => ({ ...prev, [activeIndex]: option }));
    // 选中即自动跳下一题（最后一题不跳、绝不自动提交——桌面同语义）
    if (activeIndex < questions.length - 1) {
      setActiveIndex(activeIndex + 1);
    }
  };

  const submit = () => {
    if (!allAnswered) return;
    onAnswer(
      questions.map((q, i) => ({
        question: q.question ?? "",
        answer: customText[i] ?? answers[i] ?? "",
      })),
    );
  };

  return (
    <div className="mx-3 mb-2 rounded-xl border border-brand/40 bg-card p-3 shadow-lg">
      {/* Tab 条 */}
      {questions.length > 1 ? (
        <div className="no-scrollbar -mx-1 mb-2 flex gap-1 overflow-x-auto">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIndex(i)}
              className={cn(
                "flex max-w-44 shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-ui-xs",
                i === activeIndex
                  ? "border-brand bg-accent text-foreground"
                  : "border-border bg-surface text-foreground-subtle",
              )}
            >
              {answers[i] ? <CheckCircle2 className="size-3 shrink-0 text-success" /> : null}
              <span className="truncate">{q.question}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="text-ui-base font-medium text-foreground">{current.question}</div>
      <div className="mt-2 space-y-1.5">
        {(current.options ?? []).map((option) => (
          <button
            key={option}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-ui-sm",
              answers[activeIndex] === option
                ? "border-brand bg-accent text-foreground"
                : "border-border bg-surface text-foreground-subtle",
            )}
            onClick={() => selectOption(option)}
          >
            {option === current.recommended ? (
              <span className="shrink-0 rounded bg-success/20 px-1 text-[10px] text-success">
                ✓
              </span>
            ) : null}
            <span className="min-w-0 flex-1">{option}</span>
          </button>
        ))}
      </div>
      <input
        type="text"
        value={customText[activeIndex] ?? ""}
        placeholder={t("askCustomPlaceholder")}
        className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
        onChange={(e) => {
          const value = e.target.value;
          setCustomText((prev) => ({ ...prev, [activeIndex]: value }));
          if (value) setAnswers((prev) => ({ ...prev, [activeIndex]: value }));
        }}
      />

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="h-9 rounded-lg px-3 text-ui-sm text-foreground-subtle active:opacity-80"
          onClick={onSkip}
        >
          {t("askSkip")}
        </button>
        <div className="flex-1" />
        {activeIndex < questions.length - 1 ? (
          <button
            type="button"
            className="h-9 rounded-lg border border-border bg-surface px-3 text-ui-sm font-medium text-foreground active:opacity-80"
            onClick={() => setActiveIndex(activeIndex + 1)}
          >
            {t("askNextQuestion")}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!allAnswered}
          className="h-9 rounded-lg bg-brand px-4 text-ui-sm font-medium text-white disabled:opacity-50 active:opacity-80"
          onClick={submit}
        >
          {t("askSubmit")}
        </button>
      </div>
    </div>
  );
}

export function RemotePlanCard({
  pending,
  onApprove,
  onReject,
}: {
  pending: PendingApprovalPayload;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}) {
  const t = useRemoteT();
  const [expanded, setExpanded] = useState(true);
  const [feedback, setFeedback] = useState("");
  const plan = pending.args?.plan ?? "";
  const allowedPrompts = (pending.args?.allowedPrompts ?? []) as { tool?: string; prompt?: string }[];

  return (
    <div className="mx-3 mb-2 rounded-xl border border-brand/40 bg-card p-3 shadow-lg">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="size-4 text-brand" /> : <ChevronRight className="size-4 text-brand" />}
        <span className="flex-1 text-ui-sm font-medium text-foreground">{t("planCardTitle")}</span>
        <Minus className="size-3.5 text-foreground-subtlest" />
      </button>
      {expanded ? (
        <>
          <div className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-surface px-3 py-2">
            <MobileMarkdown text={plan} />
          </div>
          {allowedPrompts.length > 0 ? (
            <div className="mt-2">
              <div className="text-ui-xs font-medium text-foreground-subtle">
                {t("planCardAllowedPrompts")}
              </div>
              <ul className="mt-1 space-y-0.5">
                {allowedPrompts.map((item, index) => (
                  <li key={index} className="font-mono text-ui-xs text-foreground-subtlest">
                    {item.tool ? `${item.tool}: ` : ""}
                    {item.prompt}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <input
            type="text"
            value={feedback}
            placeholder={t("planCardFeedbackPlaceholder")}
            className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              className="h-9 flex-1 rounded-lg border border-border bg-surface text-ui-sm font-medium text-foreground active:opacity-80"
              onClick={() => onReject(feedback)}
            >
              {t("planCardReject")}
            </button>
            <button
              type="button"
              className="h-9 flex-1 rounded-lg bg-brand text-ui-sm font-medium text-white active:opacity-80"
              onClick={onApprove}
            >
              {t("planCardApprove")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
