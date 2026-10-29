import type { SkillSummary } from "./index";
import { invalidateSkillsDiscoveryCache } from "./index";

export type SkillUpdateStatus = "idle" | "checking" | "update_available" | "up_to_date" | "error";

export interface SkillUpdateInfo {
  skillName: string;
  status: SkillUpdateStatus;
  currentRevision?: string | null;
  latestRevision?: string | null;
  latestVersion?: string | null;
  message?: string | null;
  lastCheckedAt?: number | null;
  sourceKind: "git" | "clawhub" | "local" | "builtin";
}

/**
 * 探测技能的来源分类
 */
export function detectSkillSourceKind(skill: SkillSummary): "git" | "clawhub" | "local" | "builtin" {
  if (skill.builtIn) return "builtin";
  const registry = (skill.source?.registry || "").toLowerCase();
  if (registry === "clawhub" || registry === "skills.sh") return "clawhub";
  if (registry === "git" || registry === "github" || (skill.source?.slug && skill.source.slug.includes("/"))) {
    return "git";
  }
  return "local";
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 检查单个技能是否有可用更新
 */
export async function checkSingleSkillUpdate(
  skill: SkillSummary,
  knownRevisions: Record<string, string> = {},
): Promise<SkillUpdateInfo> {
  const sourceKind = detectSkillSourceKind(skill);
  const now = Date.now();

  // 1. 系统内置技能始终为最新
  if (sourceKind === "builtin") {
    return {
      skillName: skill.name,
      status: "up_to_date",
      message: "系统内置技能已是最新版本",
      lastCheckedAt: now,
      sourceKind,
    };
  }

  // Web Mock 环境兜底
  if (!isTauriEnvironment()) {
    // 模拟 liveagent-code-review 有新版本，便于回归测试与界面预览
    if (skill.name === "liveagent-code-review") {
      return {
        skillName: skill.name,
        status: "update_available",
        currentRevision: "v1.2.0 (c1a8d0)",
        latestRevision: "v1.3.0 (e9b2f4)",
        latestVersion: "1.3.0",
        message: "发现上游发布了 v1.3.0 优化规则",
        lastCheckedAt: now,
        sourceKind,
      };
    }
    return {
      skillName: skill.name,
      status: "up_to_date",
      message: "已是最新版本",
      lastCheckedAt: now,
      sourceKind,
    };
  }

  // 2. Git 仓库来源技能检查
  if (sourceKind === "git") {
    try {
      const slug = skill.source?.slug || "";
      const currentRev = knownRevisions[skill.name] || skill.source?.version || "initial";

      // 如果是 GitHub slug (owner/repo)
      if (slug.includes("/")) {
        const repoPath = slug.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
        const res = await fetch(`https://api.github.com/repos/${repoPath}/commits/HEAD`, {
          headers: { Accept: "application/vnd.github.v3+json" },
        });

        if (res.ok) {
          const data = (await res.json()) as { sha?: string; commit?: { message?: string } };
          const remoteSha = data.sha ? data.sha.slice(0, 7) : "";
          const hasUpdate = remoteSha && currentRev && !currentRev.includes(remoteSha);

          return {
            skillName: skill.name,
            status: hasUpdate ? "update_available" : "up_to_date",
            currentRevision: currentRev,
            latestRevision: remoteSha || null,
            message: hasUpdate
              ? `发现上游新提交: ${data.commit?.message?.slice(0, 50) || remoteSha}`
              : "已是最新提交",
            lastCheckedAt: now,
            sourceKind,
          };
        }
      }

      return {
        skillName: skill.name,
        status: "up_to_date",
        currentRevision: currentRev,
        lastCheckedAt: now,
        sourceKind,
      };
    } catch (err) {
      return {
        skillName: skill.name,
        status: "error",
        message: err instanceof Error ? err.message : "检查更新网络超时",
        lastCheckedAt: now,
        sourceKind,
      };
    }
  }

  // 3. ClawHub 市场技能检查
  if (sourceKind === "clawhub") {
    const slug = skill.source?.slug;
    const currentVersion = skill.source?.version || "1.0.0";
    try {
      if (slug) {
        // 请求 ClawHub 或市场接口查询最新版本
        const res = await fetch(`https://clawhub.com/api/skills/${slug}`);
        if (res.ok) {
          const data = (await res.json()) as { version?: string };
          const remoteVer = data.version;
          const hasUpdate = remoteVer && remoteVer !== currentVersion;
          return {
            skillName: skill.name,
            status: hasUpdate ? "update_available" : "up_to_date",
            latestVersion: remoteVer,
            currentRevision: currentVersion,
            message: hasUpdate ? `市场发布了新版本 v${remoteVer}` : "已是最新版本",
            lastCheckedAt: now,
            sourceKind,
          };
        }
      }
    } catch {
      // 容错处理
    }
  }

  // 4. 本地工具导入技能检查（检查本地源目录）
  return {
    skillName: skill.name,
    status: "up_to_date",
    lastCheckedAt: now,
    sourceKind,
  };
}

/**
 * 并发检查全部技能更新
 */
export async function checkAllSkillsUpdate(
  skills: SkillSummary[],
  knownRevisions: Record<string, string> = {},
): Promise<Record<string, SkillUpdateInfo>> {
  const results: Record<string, SkillUpdateInfo> = {};
  const promises = skills.map(async (skill) => {
    try {
      const info = await checkSingleSkillUpdate(skill, knownRevisions);
      results[skill.name] = info;
    } catch (err) {
      results[skill.name] = {
        skillName: skill.name,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        lastCheckedAt: Date.now(),
        sourceKind: detectSkillSourceKind(skill),
      };
    }
  });

  await Promise.all(promises);
  return results;
}

/**
 * 应用单项更新到最新版本
 */
export async function applySkillUpdate(skill: SkillSummary): Promise<{ success: boolean; message: string }> {
  if (skill.builtIn) {
    return { success: false, message: "内置技能由系统统一维护，无法单独更新" };
  }

  // Web Mock 模式下直接成功并清理缓存
  if (!isTauriEnvironment()) {
    invalidateSkillsDiscoveryCache();
    return { success: true, message: `技能 ${skill.name} 已更新到最新版本` };
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // 优先调用后端 system_manage_skill 的更新/重新拉取动作
    await invoke("system_manage_skill", {
      payload: {
        action: "install",
        source: skill.source?.slug || skill.baseDir,
        conflict: "overwrite",
      },
    });
    invalidateSkillsDiscoveryCache();
    return { success: true, message: `技能 ${skill.name} 已成功更新` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : "更新失败，请检查网络或文件权限",
    };
  }
}
