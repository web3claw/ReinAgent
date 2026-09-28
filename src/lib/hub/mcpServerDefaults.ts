// LiveAgent 移植：crates/agent-ui/src/contracts/mcpServerDefaults.ts（一期裁剪）
// LiveAgent 的 cua-driver 受管服务器在 ReinAgent 中不存在：Hub 计数/列表对全部
// 服务器可见，isHubHiddenServerId 恒 false（语义等价、无受管条目可隐藏）。

export function isHubHiddenServerId(_serverId: string): boolean {
  return false;
}
