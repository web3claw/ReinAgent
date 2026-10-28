import { describe, it, expect } from "bun:test";
import { shouldCloseOnViewChange, shouldCloseOnTaskSwitch } from "./CodeViewerPaneHost";

describe("CodeViewerPaneHost Navigation Dismissal Logic", () => {
  it("should close pane when navigating to another view if and only if maximized", () => {
    // 留在同一视图时不关闭（无论是否最大化）
    expect(shouldCloseOnViewChange("apps", "apps", true)).toBe(false);
    expect(shouldCloseOnViewChange("workbench", "workbench", true)).toBe(false);
    expect(shouldCloseOnViewChange("apps", "apps", false)).toBe(false);

    // 视图切换但处于普通侧边栏模式（未最大化）：保持并排打开，不关闭
    expect(shouldCloseOnViewChange("workbench", "apps", false)).toBe(false);
    expect(shouldCloseOnViewChange("apps", "kanban", false)).toBe(false);

    // 视图切换且处于全屏最大化模式：必须退出最大化并关闭，防悬挂遮挡
    expect(shouldCloseOnViewChange("workbench", "apps", true)).toBe(true);
    expect(shouldCloseOnViewChange("apps", "workbench", true)).toBe(true);
    expect(shouldCloseOnViewChange("apps", "settings", true)).toBe(true);
  });

  it("should close pane on task switch if and only if maximized", () => {
    // 任务相同（未切换）时不关闭
    expect(shouldCloseOnTaskSwitch("task-1", "task-1", true)).toBe(false);
    expect(shouldCloseOnTaskSwitch("task-1", "task-1", false)).toBe(false);
    expect(shouldCloseOnTaskSwitch(null, null, true)).toBe(false);

    // 任务切换且原本处于全屏最大化：必须退出最大化并关闭
    expect(shouldCloseOnTaskSwitch("task-1", "task-2", true)).toBe(true);
    expect(shouldCloseOnTaskSwitch(null, "task-1", true)).toBe(true);
    expect(shouldCloseOnTaskSwitch("task-1", null, true)).toBe(true);

    // 任务切换但处于普通侧边栏模式：不自动强制关闭（保持普通侧边栏自然状态）
    expect(shouldCloseOnTaskSwitch("task-1", "task-2", false)).toBe(false);
  });
});
