import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import {
  ArrowUp,
  Square,
  Plus,
  AtSign,
  Terminal,
  FileCode,
  Image as ImageIcon,
  X,
  ChevronDown,
  Brain,
  Hand,
  Folder,
  FolderPlus,
  Cloud,
  MessageSquare,
  Check,
  Search,
} from "lucide-react";
import { MOCK_PROJECTS } from "../sidebar/WorkspaceSidebar";

export interface LexicalComposerProps {
  isStreaming: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
  providerName?: string;
  modelId?: string;
  hasMessages?: boolean;
  focusRequestTrigger?: number;
}

export const LexicalComposer: React.FC<LexicalComposerProps> = ({
  isStreaming,
  onSend,
  onStop,
  providerName = "DeepSeek",
  modelId = "v3",
  hasMessages = false,
  focusRequestTrigger,
}) => {
  const { t } = useTranslation();
  const {
    thinkingLevel,
    setThinkingLevel,
    approvalMode,
    setApprovalMode,
    selectedProject,
    setSelectedProject,
  } = useAppStore();

  const [text, setText] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [remoteHost, setRemoteHost] = useState("");

  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMentionMenu(false);
        setShowSlashMenu(false);
        setShowApprovalMenu(false);
        setShowThinkingMenu(false);
        setShowProjectMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (focusRequestTrigger !== undefined && focusRequestTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusRequestTrigger]);

  // Keep focused when mounted in hasMessages mode
  useEffect(() => {
    if (hasMessages) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [hasMessages]);

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
      // Keep input focused after sending
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
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
      setShowProjectMenu(false);
      setShowRemoteDialog(false);
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

  const availableProjects = MOCK_PROJECTS.map((p) => p.name);
  const filteredProjects = availableProjects.filter((name) =>
    name.toLowerCase().includes(projectSearchQuery.toLowerCase().trim())
  );

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const firstPath = files[0].webkitRelativePath;
      const folderName = firstPath ? firstPath.split("/")[0] : files[0].name;
      if (folderName) {
        setSelectedProject(folderName);
      }
    }
  };

  const placeholder = hasMessages 
    ? (t("composerPlaceholderFollowUp") || "提出后续修改要求") 
    : (t("composerPlaceholder") || "向 ReinAgent 提问，@ 添加上下文，/ 选择命令");

  const innerCard = (
    <div
      className={`relative ${
        hasMessages
          ? "rounded-2xl border border-[var(--capsule-border)] shadow-[var(--capsule-shadow)]"
          : "rounded-2xl border-t border-[var(--capsule-border)] shadow-xs"
      } bg-[var(--capsule-bg)] w-full flex flex-col overflow-visible`}
    >
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
        rows={hasMessages ? 2 : 3}
        value={text}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none leading-relaxed"
      />

      {/* Toolbar: 无分割线，左右分布 */}
      <div className="flex items-center justify-between px-3 pb-2.5 pt-1 relative">
        {/* 左侧：+ 号添加附件 & 审批模式（如 ✋ 变更前确认 ∨） */}
        <div className="flex items-center gap-1.5">
          {/* Add / Attach Button */}
          <button
            type="button"
            onClick={addMockAttachment}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center cursor-pointer"
            title={t("attachFile")}
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* Approval Mode Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowApprovalMenu(!showApprovalMenu);
                setShowThinkingMenu(false);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Hand className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>
                {approvalMode === 'always' ? t("approvalAlways") :
                 approvalMode === 'suggest' ? (t("confirmBeforeChange") || t("approvalSuggest")) :
                 t("approvalAuto")}
              </span>
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
            {showApprovalMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-36 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
                {(['suggest', 'always', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setApprovalMode?.(mode);
                      setShowApprovalMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] cursor-pointer"
                  >
                    {mode === 'always' ? t("approvalAlways") :
                     mode === 'suggest' ? (t("confirmBeforeChange") || t("approvalSuggest")) :
                     t("approvalAuto")}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：模型选择、思考深度、发送按钮 */}
        <div className="flex items-center gap-2">
          {/* Model Selector (Display only) */}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <span className="w-2 h-2 rounded-full border border-current opacity-60 inline-block mr-0.5" />
            <span>{providerName}/{modelId}</span>
            <ChevronDown className="w-3 h-3 opacity-70" />
          </button>

          {/* Thinking Level Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowThinkingMenu(!showThinkingMenu);
                setShowApprovalMenu(false);
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Brain className="w-3.5 h-3.5 opacity-80" />
              <span>
                {thinkingLevel === 'off' ? t("thinkingOff") :
                 thinkingLevel === 'low' ? t("thinkingLow") :
                 thinkingLevel === 'medium' ? t("thinkingMedium") :
                 thinkingLevel === 'high' ? t("thinkingHigh") :
                 t("thinkingMax")}
              </span>
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
            {showThinkingMenu && (
              <div className="absolute bottom-full right-0 mb-2 w-32 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
                {(['off', 'low', 'medium', 'high', 'max'] as const).map((level) => (
                  <button
                    key={level}
                    onClick={() => {
                      setThinkingLevel?.(level);
                      setShowThinkingMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] cursor-pointer"
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

          {/* Send/Stop Button */}
          <div className="flex items-center ml-1">
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="w-7 h-7 rounded-lg bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-xs cursor-pointer"
                title={t("stop")}
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={text.trim().length === 0 && attachments.length === 0}
                className="w-7 h-7 rounded-lg bg-[#5c5c60] hover:bg-[#6e6e73] dark:bg-[#5c5c60] dark:hover:bg-[#6e6e73] text-white flex items-center justify-center disabled:opacity-35 disabled:hover:bg-[#5c5c60] transition-all cursor-pointer shadow-xs"
                title={t("send")}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (hasMessages) {
    return (
      <div ref={containerRef} className="relative w-full overflow-visible">
        {innerCard}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="relative rounded-2xl border border-[var(--capsule-outer-border)] bg-[var(--capsule-outer-bg)] shadow-[var(--capsule-shadow)] w-full flex flex-col transition-all overflow-visible"
    >
      {/* Hidden Folder Picker Input */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderChange}
      />

      {/* Top Outer Layer: Project Selector Header */}
      <div className="px-4 pt-2.5 pb-2.5 flex items-center justify-between">
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowProjectMenu(!showProjectMenu);
              setShowMentionMenu(false);
              setShowSlashMenu(false);
              setShowApprovalMenu(false);
              setShowThinkingMenu(false);
            }}
            className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none py-1 px-1.5 rounded-md hover:bg-[var(--surface-hover)] -ml-1"
          >
            <Folder className="w-3.5 h-3.5 opacity-80" />
            <span className="font-normal">{selectedProject || t("selectProject")}</span>
            <ChevronDown className="w-3 h-3 opacity-60 ml-0.5" />
          </button>

          {showProjectMenu && (
            <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-2xl py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2 backdrop-blur-md">
              {/* Search input */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--capsule-border)]">
                <Search className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <input
                  type="text"
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  placeholder={t("searchWorkspace")}
                  className="w-full bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none"
                  autoFocus
                />
              </div>

              {/* Project items */}
              <div className="max-h-48 overflow-y-auto py-1">
                {filteredProjects.map((proj) => (
                  <button
                    key={proj}
                    type="button"
                    onClick={() => {
                      setSelectedProject(proj);
                      setShowProjectMenu(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                      <span className="truncate">{proj}</span>
                    </div>
                    {selectedProject === proj && (
                      <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-2" />
                    )}
                  </button>
                ))}
                {filteredProjects.length === 0 && (
                  <div className="px-3 py-2 text-[var(--text-secondary)] text-center text-xs">
                    无匹配工作区
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--capsule-border)] my-1" />

              {/* Action: 打开文件夹 */}
              <button
                type="button"
                onClick={() => {
                  folderInputRef.current?.click();
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <FolderPlus className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <span>{t("openFolder")}</span>
              </button>

              {/* Action: 远程连接 */}
              <button
                type="button"
                onClick={() => {
                  setShowRemoteDialog(true);
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <Cloud className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <span>{t("remoteConnect")}</span>
              </button>

              {/* Action: 不在项目中工作 */}
              <button
                type="button"
                onClick={() => {
                  setSelectedProject(null);
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <div className="flex items-center gap-2 truncate">
                  <MessageSquare className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                  <span>{t("workOutsideProject")}</span>
                </div>
                {selectedProject === null && (
                  <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-2" />
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inner Card (The second layer!) */}
      {innerCard}

      {/* Remote Connection Dialog Modal */}
      {showRemoteDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--surface)] border border-[var(--capsule-border)] rounded-xl shadow-2xl p-5 w-full max-w-sm flex flex-col gap-3.5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-sm text-[var(--text-primary)]">
                <Cloud className="w-4 h-4 text-blue-500" />
                <span>{t("remoteConnect")}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowRemoteDialog(false)}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-[var(--text-secondary)]">
                输入远程主机或 SSH 连接串
              </label>
              <input
                type="text"
                placeholder="ssh://user@hostname:path"
                value={remoteHost}
                onChange={(e) => setRemoteHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && remoteHost.trim()) {
                    setSelectedProject(remoteHost.trim());
                    setShowRemoteDialog(false);
                  }
                }}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[var(--bg)] border border-[var(--capsule-border)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 text-xs pt-1">
              <button
                type="button"
                onClick={() => setShowRemoteDialog(false)}
                className="px-3 py-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] cursor-pointer"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (remoteHost.trim()) {
                    setSelectedProject(remoteHost.trim());
                    setShowRemoteDialog(false);
                  }
                }}
                disabled={!remoteHost.trim()}
                className="px-3.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white cursor-pointer font-medium transition-colors"
              >
                连接
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
