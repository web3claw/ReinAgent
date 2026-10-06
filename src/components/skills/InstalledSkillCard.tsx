// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/InstalledSkillCard.tsx>
// 适配：图标 lucide-react 同名 + SkillIcon（lw/icons/brand-icons）；
// ConfirmDeletePopover 文案改为必填 props 注入（lw 移植铁律）。
import type { ComponentType } from "react";
import {
  BookOpen,
  Bot,
  Brain,
  Cable,
  CircleHelp,
  Cloud,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  Globe,
  ImageIcon,
  Key,
  LayoutGrid,
  Lightbulb,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  MessageSquare,
  Plug,
  Radio,
  RefreshCw,
  ScanText,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  Waypoints,
  Wifi,
  Wrench,
  Zap,
} from "lucide-react";
import { ResourceActivationSwitch } from "../lw/resources/ResourceActivationSwitch";
import { Badge } from "../lw/ui/badge";
import { Button } from "../lw/ui/button";
import { Checkbox } from "../lw/ui/checkbox";
import { ConfirmDeletePopover } from "../lw/ui/confirm-action-popover";
import { SearchHighlight } from "../lw/ui/search-highlight";
import { cn } from "../lw/lib/utils";
import type { ClawHubCategorySlug } from "../../lib/skills/clawHubCategories";
import type { SkillSummary } from "../../lib/skills/index";
import {
  getInstalledSkillCardIdentity,
  type InstalledSkillCardIconName,
} from "../../lib/skills/skillCardIdentity";
import {
  getInstalledSkillCardSource,
  getRelativeInstalledAt,
} from "../../lib/skills/skillCardMetadata";
import { memo, useMemo } from "react";
import { InstalledSkillCategoryChip } from "./SkillCategoryControls";
import { SKILL_CARD_SHELL_CLASS } from "./skillCardLayout";
import { useLocale } from "./useLocale";

type CardIconComponent = ComponentType<{ className?: string }>;

const INSTALLED_SKILL_CARD_ICONS: Record<InstalledSkillCardIconName, CardIconComponent> = {
  bookOpen: BookOpen,
  bot: Bot,
  brain: Brain,
  cable: Cable,
  circleHelp: CircleHelp,
  cloud: Cloud,
  cpu: Cpu,
  fileText: FileText,
  folder: Folder,
  gitBranch: GitBranch,
  globe: Globe,
  imageIcon: ImageIcon,
  key: Key,
  layoutGrid: LayoutGrid,
  lightbulb: Lightbulb,
  link2: Link2,
  listChecks: ListChecks,
  lock: Lock,
  messageSquare: MessageSquare,
  plug: Plug,
  radio: Radio,
  refreshCw: RefreshCw,
  scanText: ScanText,
  scrollText: ScrollText,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  terminal: Terminal,
  timer: Timer,
  waypoints: Waypoints,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
};

let cachedFullDateFormat: Intl.DateTimeFormat | null = null;

function getFullDateFormat() {
  cachedFullDateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return cachedFullDateFormat;
}

function formatInstalledSkillMetadata(skill: SkillSummary, t: (key: string) => string): string {
  const source = getInstalledSkillCardSource(skill);
  const sourceLabel =
    source === "built-in"
      ? t("settings.skillsInstalledCardSourceBuiltIn")
      : source === "clawhub"
        ? t("settings.skillsInstalledCardSourceClawHub")
        : t("settings.skillsInstalledCardSourceLocal");
  if (source === "built-in") return sourceLabel;

  const relativeInstalledAt = getRelativeInstalledAt(skill.installedAt);
  if (!relativeInstalledAt) return sourceLabel;
  if (relativeInstalledAt.kind === "today") {
    return `${sourceLabel} · ${t("settings.skillsInstalledCardInstalledToday")}`;
  }
  if (relativeInstalledAt.kind === "days-ago") {
    return `${sourceLabel} · ${t("settings.skillsInstalledCardInstalledDaysAgo").replace(
      "{count}",
      String(relativeInstalledAt.days),
    )}`;
  }

  const date = getFullDateFormat().format(new Date(relativeInstalledAt.timestamp));
  return `${sourceLabel} · ${date}`;
}

type InstalledSkillCardProps = {
  skill: SkillSummary;
  primaryCategory: ClawHubCategorySlug;
  builtIn: boolean;
  checked: boolean;
  skillsEnabled: boolean;
  bulkMode: boolean;
  bulkSelected: boolean;
  deleting: boolean;
  deleteDisabled: boolean;
  searchQuery: string;
  onToggle: (name: string, on: boolean) => void;
  onEnterBulkMode: (name: string) => void;
  onToggleBulkSelection: (name: string) => void;
  onBulkCardClick: (name: string, shiftKey: boolean) => void;
  onOpenPreview: (skill: SkillSummary) => void;
  onDelete: (skill: SkillSummary) => void;
  onSelectCategory: (category: ClawHubCategorySlug) => void;
};

// 安装卡片抽成 memo 组件：props 只传标量与稳定引用（布尔代替 Set 成员判断、
// primaryCategory 代替数组、latest-ref 回调），父组件的无关状态更新（搜索、
// store 轮询、抽屉开关等）不再重渲整片网格；identity/metadata 等派生计算
// 也随之只在自身输入变化时重算。技能数量大时这是主要的卡顿来源。
export const InstalledSkillCard = memo(function InstalledSkillCard(props: InstalledSkillCardProps) {
  const {
    skill,
    primaryCategory,
    builtIn,
    checked,
    skillsEnabled,
    bulkMode,
    bulkSelected,
    deleting,
    deleteDisabled,
    searchQuery,
    onToggle,
    onEnterBulkMode,
    onToggleBulkSelection,
    onBulkCardClick,
    onOpenPreview,
    onDelete,
    onSelectCategory,
  } = props;
  const { t } = useLocale();
  const effectivelyEnabled = skillsEnabled && checked;
  const cardIdentity = useMemo(
    () => getInstalledSkillCardIdentity(skill.name, primaryCategory),
    [primaryCategory, skill.name],
  );
  const CardIcon: CardIconComponent =
    INSTALLED_SKILL_CARD_ICONS[cardIdentity?.iconName ?? "circleHelp"];
  const metadataSource = getInstalledSkillCardSource(skill);
  const MetadataIcon: CardIconComponent =
    metadataSource === "built-in" ? Lock : metadataSource === "clawhub" ? Cloud : Folder;
  const metadataLabel = useMemo(() => formatInstalledSkillMetadata(skill, t), [skill, t]);
  const cardContent = (
    <>
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          "text-muted-foreground transition-colors group-hover:text-foreground/70",
          !effectivelyEnabled && "opacity-70",
        )}
      >
        <CardIcon className="size-4" />
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 transition-opacity",
          !effectivelyEnabled && "opacity-75",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SearchHighlight
            text={skill.name}
            query={searchQuery}
            className="truncate text-sm font-semibold text-foreground"
          />
          {effectivelyEnabled ? (
            <Badge variant="success" className="h-5 px-1.5 text-tiny">
              {t("settings.skillsHubEnabledBadge")}
            </Badge>
          ) : null}
        </div>
        {skill.description ? (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
            <SearchHighlight text={skill.description} query={searchQuery} />
          </p>
        ) : null}
        <div className="mt-1 flex min-w-0 items-center gap-2 text-tiny text-muted-foreground">
          <InstalledSkillCategoryChip category={primaryCategory} onSelect={onSelectCategory} />
          <span className="inline-flex min-w-0 items-center gap-1">
            <MetadataIcon className="size-3 shrink-0" />
            <span className="truncate">{metadataLabel}</span>
          </span>
        </div>
      </div>

      <div
        data-card-action-zone=""
        role="toolbar"
        aria-label={skill.name}
        className="flex shrink-0 items-center gap-1 self-center"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {bulkMode ? (
          <Checkbox
            checked={bulkSelected}
            aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${skill.name}`}
            onCheckedChange={() => onToggleBulkSelection(skill.name)}
          />
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "text-muted-foreground opacity-0 transition-opacity",
                "group-hover:opacity-100 focus-visible:opacity-100",
                "[@media(hover:none)]:opacity-100",
              )}
              aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${skill.name}`}
              title={t("settings.skillsHubBulkSelect")}
              onClick={() => onEnterBulkMode(skill.name)}
            >
              <ListChecks className="size-3.5" />
            </Button>
            {!builtIn ? (
              <ConfirmDeletePopover
                name={skill.name}
                title={t("settings.deleteConfirm")}
                confirmLabel={t("settings.delete")}
                cancelLabel={t("settings.cancel")}
                description={(name) => (
                  <>
                    {t("settings.deleteConfirmYes")}{" "}
                    <span className="font-medium text-foreground">{name}</span>？
                    {t("settings.deleteConfirmDesc")}
                  </>
                )}
                onConfirm={() => onDelete(skill)}
              >
                {(open) => (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "text-muted-foreground opacity-0 transition-opacity",
                      "group-hover:opacity-100 focus-visible:opacity-100",
                      "hover:bg-destructive/10 hover:text-destructive",
                      "[@media(hover:none)]:opacity-100",
                    )}
                    disabled={deleteDisabled}
                    aria-label={`${t("settings.skillsHubDeleteSkill")}: ${skill.name}`}
                    onClick={open}
                    title={t("settings.skillsHubDeleteSkill")}
                  >
                    {deleting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                )}
              </ConfirmDeletePopover>
            ) : null}
            <ResourceActivationSwitch
              checked={effectivelyEnabled}
              disabled={!skillsEnabled}
              compact
              stopPropagation
              label={`${t("skills.select")}: ${skill.name}`}
              onCheckedChange={(nextChecked) => onToggle(skill.name, nextChecked)}
            />
          </>
        )}
      </div>
    </>
  );

  const cardClassName = cn(
    SKILL_CARD_SHELL_CLASS,
    "[content-visibility:auto] [contain-intrinsic-size:auto_4.5rem]",
    bulkSelected && "bg-settings-active",
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
    <div
      role="button"
      tabIndex={0}
      aria-label={`${t("settings.skillsInstalledPreviewOpen")}: ${skill.name}`}
      onClick={(event) => {
        if (bulkMode) onBulkCardClick(skill.name, event.shiftKey);
        else onOpenPreview(skill);
      }}
      onMouseDown={(event) => {
        if (bulkMode && event.shiftKey) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (bulkMode) onBulkCardClick(skill.name, event.shiftKey);
        else onOpenPreview(skill);
      }}
      className={cn(
        cardClassName,
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {cardContent}
    </div>
  );
});
