// LiveAgent 移植：crates/agent-ui/src/lib/skills/useChatSkills.ts（改写适配本项目）
//
// LA 原版入参绑定 LA 的 settings 体系（AppSettings + updateSkills）；本项目暂无
// 对应体系（二期接线），改为纯回调形态：
//   - enabled / selected 由调用方（Hub 页面）持有；
//   - reconcileSelectedSkills 不再回写 settings，而是把收敛后的选中名单经
//     onSelectedChange 交还调用方持久化；
//   - 每次（重）发现完成后触发 onDiscoveryChanged。
// 核心链路不变：discoverSkills + reconcileSelectedSkills +
// subscribeSkillsDiscoveryUpdated（window 自定义事件，纯前端可用）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  discoverSkills,
  type SkillSummary,
  subscribeSkillsDiscoveryUpdated,
} from "./index";

type UseChatSkillsParams = {
  skillsEnabled: boolean;
  selectedSkillNames: string[];
  onSelectedChange?: (next: string[]) => void;
  onDiscoveryChanged?: () => void;
};

function reconcileSelectedSkills(params: {
  skills: SkillSummary[];
  selectedSkillNames: string[];
  onSelectedChange?: (next: string[]) => void;
}) {
  const { skills, selectedSkillNames, onSelectedChange } = params;
  if (!onSelectedChange) return;

  const names = new Set(skills.map((skill) => skill.name));
  const filtered = selectedSkillNames.filter((name) => names.has(name));
  if (filtered.join("\n") === selectedSkillNames.join("\n")) return;

  onSelectedChange(filtered);
}

export function useChatSkills(params: UseChatSkillsParams) {
  const { skillsEnabled, selectedSkillNames, onSelectedChange, onDiscoveryChanged } = params;
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([]);
  const [skillsRootDir, setSkillsRootDir] = useState("");
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoadError, setSkillsLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const selectedSkillNamesRef = useRef(selectedSkillNames);
  const onSelectedChangeRef = useRef(onSelectedChange);
  const onDiscoveryChangedRef = useRef(onDiscoveryChanged);

  useEffect(() => {
    selectedSkillNamesRef.current = selectedSkillNames;
  }, [selectedSkillNames]);

  useEffect(() => {
    onSelectedChangeRef.current = onSelectedChange;
  }, [onSelectedChange]);

  useEffect(() => {
    onDiscoveryChangedRef.current = onDiscoveryChanged;
  }, [onDiscoveryChanged]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyDisabledState = useCallback(() => {
    if (!mountedRef.current) return;
    setAvailableSkills([]);
    setSkillsRootDir("");
    setSkillsLoadError(null);
    setSkillsLoading(false);
  }, []);

  const runDiscovery = useCallback(
    async (options?: { force?: boolean }) => {
      if (!skillsEnabled) {
        requestSequenceRef.current += 1;
        applyDisabledState();
        return null;
      }

      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      if (mountedRef.current) {
        setSkillsLoading(true);
        setSkillsLoadError(null);
      }

      try {
        const discovery = await discoverSkills({
          force: options?.force,
        });
        if (!mountedRef.current || requestSequenceRef.current !== requestId) {
          return null;
        }
        setSkillsRootDir(discovery.rootDir);
        setAvailableSkills(discovery.skills);
        reconcileSelectedSkills({
          skills: discovery.skills,
          selectedSkillNames: selectedSkillNamesRef.current,
          onSelectedChange: onSelectedChangeRef.current,
        });
        onDiscoveryChangedRef.current?.();
        return discovery;
      } catch (err) {
        if (!mountedRef.current || requestSequenceRef.current !== requestId) {
          return null;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setSkillsRootDir("");
        setAvailableSkills([]);
        setSkillsLoadError(msg || "加载 skills 失败");
        return null;
      } finally {
        if (mountedRef.current && requestSequenceRef.current === requestId) {
          setSkillsLoading(false);
        }
      }
    },
    [applyDisabledState, skillsEnabled],
  );

  const refreshSkills = useCallback(async () => {
    return runDiscovery({ force: true });
  }, [runDiscovery]);

  useEffect(() => {
    void runDiscovery();
  }, [runDiscovery]);

  useEffect(() => {
    if (!skillsEnabled) return;
    return subscribeSkillsDiscoveryUpdated(() => {
      void runDiscovery({ force: true });
    });
  }, [runDiscovery, skillsEnabled]);

  return {
    availableSkills,
    skillsRootDir,
    skillsLoading,
    skillsLoadError,
    refreshSkills,
  };
}
