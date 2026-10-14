import React, { useState, useRef, useEffect } from "react";
import { Folder, ChevronDown, Check, Plus } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { NotebookFolder } from "./notesService";

interface NotebookDropdownProps {
  notebooks: NotebookFolder[];
  selectedPath: string;
  onSelect: (relativePath: string) => void;
  onCreateNotebook: (parentPath: string | null, name: string) => Promise<void>;
}

export function NotebookDropdown({
  notebooks,
  selectedPath,
  onSelect,
  onCreateNotebook,
}: NotebookDropdownProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowCreateInput(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleCreate = async () => {
    const trimmed = newNotebookName.trim();
    if (!trimmed) return;
    try {
      await onCreateNotebook(selectedPath === "default" ? null : selectedPath, trimmed);
      setNewNotebookName("");
      setShowCreateInput(false);
    } catch (err) {
      console.error(err);
    }
  };

  // 扁平化展示笔记本（带层级缩进）
  const renderNotebookItems = (list: NotebookFolder[], depth = 0): React.ReactNode => {
    return list.map((nb) => {
      const isSelected = selectedPath === nb.relativePath;
      const displayName = nb.name === "default" ? t("defaultNotebookName") : nb.name;
      return (
        <React.Fragment key={nb.id}>
          <button
            type="button"
            onClick={() => {
              onSelect(nb.relativePath);
              setIsOpen(false);
            }}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors text-left ${
              isSelected
                ? "bg-[var(--accent)] text-white font-medium"
                : "text-[var(--text)] hover:bg-[var(--surface-hover)]"
            }`}
            style={{ paddingLeft: `${12 + depth * 14}px` }}
          >
            <div className="flex items-center gap-2 truncate">
              <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-white" : "text-[var(--accent)]"}`} />
              <span className="truncate">{displayName}</span>
            </div>
            {isSelected && <Check className="w-3.5 h-3.5 shrink-0 ml-2" />}
          </button>
          {nb.children && nb.children.length > 0 && renderNotebookItems(nb.children, depth + 1)}
        </React.Fragment>
      );
    });
  };

  const currentDisplayName =
    selectedPath === "default"
      ? t("defaultNotebookName")
      : selectedPath.split("/").pop() || selectedPath;

  return (
    <div className="relative w-full" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elev-2)] hover:bg-[var(--surface-hover)] transition-all text-xs font-medium text-[var(--text)] shadow-xs"
      >
        <div className="flex items-center gap-2 truncate">
          <Folder className="w-4 h-4 text-[var(--accent)] shrink-0" />
          <span className="truncate font-semibold">{currentDisplayName}</span>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--text-dim)] transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1.5 z-50 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-1.5 shadow-xl max-h-72 overflow-y-auto animate-in fade-in zoom-in-95 duration-100">
          <div className="space-y-0.5 mb-1.5">{renderNotebookItems(notebooks)}</div>

          <div className="border-t border-[var(--border)] pt-1.5">
            {!showCreateInput ? (
              <button
                type="button"
                onClick={() => setShowCreateInput(true)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors font-medium"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t("newNotebook")}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 px-1 py-1">
                <input
                  type="text"
                  autoFocus
                  value={newNotebookName}
                  onChange={(e) => setNewNotebookName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") setShowCreateInput(false);
                  }}
                  placeholder={t("newNotebookPlaceholder")}
                  className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-[var(--text)] outline-hidden focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  className="px-2.5 py-1 text-xs bg-[var(--accent)] text-white rounded-md font-medium hover:opacity-90 transition-opacity"
                >
                  OK
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
