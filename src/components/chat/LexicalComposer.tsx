import React, { useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  Send,
  Square,
  Paperclip,
  AtSign,
  Terminal,
  FileCode,
  Image as ImageIcon,
  X,
} from "lucide-react";

export interface LexicalComposerProps {
  isStreaming: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
}

export const LexicalComposer: React.FC<LexicalComposerProps> = ({
  isStreaming,
  onSend,
  onStop,
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // Detect @ or / trigger
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
    <div className="relative border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
      {/* Mention Dropdown */}
      {showMentionMenu && (
        <div className="absolute bottom-full left-4 mb-2 w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-lg py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2">
          <div className="px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--border)] flex items-center gap-1.5">
            <AtSign className="w-3.5 h-3.5" />
            <span>Mention context</span>
          </div>
          <button
            type="button"
            onClick={() => insertMention("workspace")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center gap-2"
          >
            <FileCode className="w-3.5 h-3.5 text-blue-500" />
            <span>@workspace</span>
          </button>
          <button
            type="button"
            onClick={() => insertMention("terminal")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center gap-2"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-500" />
            <span>@terminal</span>
          </button>
        </div>
      )}

      {/* Slash Command Dropdown */}
      {showSlashMenu && (
        <div className="absolute bottom-full left-4 mb-2 w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-lg py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2">
          <div className="px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--border)]">
            <span>Quick Commands</span>
          </div>
          <button
            type="button"
            onClick={() => insertSlashCommand("/edit")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex flex-col"
          >
            <span className="font-medium text-emerald-500">/edit [path]</span>
            <span className="text-[10px] text-[var(--text-secondary)]">Edit a target file</span>
          </button>
          <button
            type="button"
            onClick={() => insertSlashCommand("/terminal")}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex flex-col"
          >
            <span className="font-medium text-blue-500">/terminal [command]</span>
            <span className="text-[10px] text-[var(--text-secondary)]">Execute bash command</span>
          </button>
        </div>
      )}

      {/* Attachments List */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-primary)]"
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

      {/* Input Area */}
      <div className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)] focus-within:border-[var(--accent)] transition-colors">
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={t("inputPlaceholder")}
          className="w-full resize-none bg-transparent p-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none leading-relaxed"
        />

        <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--border)]">
          <div className="flex items-center gap-1 text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={addMockAttachment}
              className="p-1.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="Add attachment"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => insertMention("workspace")}
              className="p-1.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="Mention"
            >
              <AtSign className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs font-medium transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>{t("stop")}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={text.trim().length === 0 && attachments.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-all shadow-sm"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{t("send")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
