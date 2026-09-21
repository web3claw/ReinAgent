import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import {
  ArrowUp,
  Square,
  Paperclip,
  AtSign,
  Terminal,
  FileCode,
  Image as ImageIcon,
  X,
  ChevronDown,
  Hand,
  Brain,
} from "lucide-react";

export interface LexicalComposerProps {
  isStreaming: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
  providerName?: string;
  modelId?: string;
}

export const LexicalComposer: React.FC<LexicalComposerProps> = ({
  isStreaming,
  onSend,
  onStop,
  providerName = "DeepSeek",
  modelId = "v3",
}) => {
  const { t } = useTranslation();
  const { thinkingLevel, setThinkingLevel, approvalMode, setApprovalMode } = useAppStore();

  const [text, setText] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);

  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMentionMenu(false);
        setShowSlashMenu(false);
        setShowApprovalMenu(false);
        setShowThinkingMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const submit = () => {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || isStreaming) return;

    let payload = trimmed;
    if (attachments.length > 0) {
      const attachDesc = attachments.map((a) => `[Attachment: ${a.name}]`).join(" ");
      payload = payload ? `${payload}\n\n${attachDesc}` : attachDesc;
    }

    if (onSend(payload)) {
      setText("");
      setAttachments([]);
      setShowMentionMenu(false);
      setShowSlashMenu(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === "Escape") {
      setShowMentionMenu(false);
      setShowSlashMenu(false);
      setShowApprovalMenu(false);
      setShowThinkingMenu(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const lastChar = val.slice(-1);
    if (lastChar === "@") {
      setShowMentionMenu(true);
      setShowSlashMenu(false);
    } else if (lastChar === "/") {
      setShowSlashMenu(true);
      setShowMentionMenu(false);
    } else if (val === "" || val.endsWith(" ")) {
      setShowMentionMenu(false);
      setShowSlashMenu(false);
    }
  };

  const insertMention = (item: string) => {
    setText((prev) => prev + item + " ");
    setShowMentionMenu(false);
    textareaRef.current?.focus();
  };

  const insertSlashCommand = (cmd: string) => {
    setText((prev) => prev.replace(/\/$/, "") + cmd + " ");
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  const addMockAttachment = () => {
    const newId = Date.now().toString();
    setAttachments((prev) => [...prev, { id: newId, name: `file-${prev.length + 1}.png` }]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div 
      ref={containerRef}
      className="relative rounded-2xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-[var(--capsule-shadow)] max-w-2xl mx-auto w-full flex flex-col transition-all"
    >
      {/* Project Tag (Optional Mock) */}
      <div className="px-4 py-2 border-b border-[var(--capsule-border)] text-xs text-[var(--text-secondary)] flex items-center gap-1">
        <span className="flex items-center gap-1 cursor-pointer hover:text-[var(--text-primary)]">
          deepseek-harness-plugin <ChevronDown className="w-3 h-3" />
        </span>
      </div>

      {/* Attachments inside the capsule, above text area */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--surface)] border border-[var(--capsule-border)] text-xs text-[var(--text-primary)]"
            >
              <ImageIcon className="w-3.5 h-3.5 text-blue-500" />
              <span>{a.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="text-[var(--text-secondary)] hover:text-red-500 ml-1"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Mention Dropdown */}
      {showMentionMenu && (
        <div className="absolute bottom-full left-4 mb-2 w-56 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2">
          <div className="px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--capsule-border)] flex items-center gap-1.5">
            <AtSign className="w-3.5 h-3.5" />
            <span>Mention context</span>
          </div>
          <button
            type="button"
            onClick={() => insertMention("workspace")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)] flex items-center gap-2"
          >
            <FileCode className="w-3.5 h-3.5 text-blue-500" />
            <span>@workspace</span>
          </button>
          <button
            type="button"
            onClick={() => insertMention("terminal")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)] flex items-center gap-2"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-500" />
            <span>@terminal</span>
          </button>
        </div>
      )}

      {/* Slash Command Dropdown */}
      {showSlashMenu && (
        <div className="absolute bottom-full left-4 mb-2 w-64 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2">
          <div className="px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--capsule-border)]">
            <span>Quick Commands</span>
          </div>
          <button
            type="button"
            onClick={() => insertSlashCommand("/edit")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)] flex flex-col"
          >
            <span className="font-medium text-emerald-500">/edit [path]</span>
            <span className="text-[10px] text-[var(--text-secondary)]">Edit a target file</span>
          </button>
          <button
            type="button"
            onClick={() => insertSlashCommand("/terminal")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)] flex flex-col"
          >
            <span className="font-medium text-blue-500">/terminal [command]</span>
            <span className="text-[10px] text-[var(--text-secondary)]">Execute bash command</span>
          </button>
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        rows={3}
        value={text}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={t("composerPlaceholder") || "向 ReinAgent 提问，@ 添加上下文，/ 选择命令"}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none leading-relaxed"
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--capsule-border)] relative">
        <div className="flex items-center gap-2">
          {/* Attach Button */}
          <button
            type="button"
            onClick={addMockAttachment}
            className="p-1.5 rounded-full hover:bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center"
            title={t("attachFile")}
          >
            <Paperclip className="w-4 h-4" />
          </button>

          {/* Approval Mode Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowApprovalMenu(!showApprovalMenu);
                setShowThinkingMenu(false);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--surface)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Hand className="w-3.5 h-3.5" />
              <span>
                {approvalMode === 'always' ? t("approvalAlways") :
                 approvalMode === 'suggest' ? t("approvalSuggest") :
                 t("approvalAuto")}
              </span>
              <ChevronDown className="w-3 h-3" />
            </button>
            {showApprovalMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-36 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
                {(['always', 'suggest', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setApprovalMode?.(mode);
                      setShowApprovalMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)]"
                  >
                    {mode === 'always' ? t("approvalAlways") :
                     mode === 'suggest' ? t("approvalSuggest") :
                     t("approvalAuto")}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model Selector (Display only) */}
          <button
            type="button"
            className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--surface)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <span>{providerName}/{modelId}</span>
            <ChevronDown className="w-3 h-3" />
          </button>

          {/* Thinking Level Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowThinkingMenu(!showThinkingMenu);
                setShowApprovalMenu(false);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--surface)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Brain className="w-3.5 h-3.5" />
              <span>
                {thinkingLevel === 'off' ? t("thinkingOff") :
                 thinkingLevel === 'low' ? t("thinkingLow") :
                 thinkingLevel === 'medium' ? t("thinkingMedium") :
                 thinkingLevel === 'high' ? t("thinkingHigh") :
                 t("thinkingMax")}
              </span>
              <ChevronDown className="w-3 h-3" />
            </button>
            {showThinkingMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-32 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
                {(['off', 'low', 'medium', 'high', 'max'] as const).map((level) => (
                  <button
                    key={level}
                    onClick={() => {
                      setThinkingLevel?.(level);
                      setShowThinkingMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface)] text-[var(--text-primary)]"
                  >
                    {level === 'off' ? t("thinkingOff") :
                     level === 'low' ? t("thinkingLow") :
                     level === 'medium' ? t("thinkingMedium") :
                     level === 'high' ? t("thinkingHigh") :
                     t("thinkingMax")}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Send/Stop Button */}
        <div className="flex items-center">
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-sm"
              title={t("stop")}
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={text.trim().length === 0 && attachments.length === 0}
              className="w-8 h-8 rounded-full bg-[var(--brand)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-40 disabled:bg-[var(--surface)] disabled:text-[var(--text-secondary)] transition-all shadow-sm"
              title={t("send")}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
