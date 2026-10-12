import { describe, it, expect, beforeEach } from "bun:test";
import {
  refuseSelfTargetedCall,
  refuseSelfRegionCall,
  usesDesktopScreenCoordinates,
  stripSelfFromJsonText,
  resetCuaSelfGuardCaches,
  isDesktopKeyboardCall,
  refuseDesktopKeyboardCall,
  CUA_SELF_TARGET_REFUSAL,
  CUA_SELF_REGION_REFUSAL,
  CUA_SELF_FOREGROUND_REFUSAL,
  CUA_SELF_FOREGROUND_UNKNOWN_REFUSAL,
  CUA_SELF_SCAN_DEPTH_REFUSAL,
} from "./cuaSelfGuard.ts";

const SELF_PID = 4242;
const OTHER_PID = 99;

describe("cuaSelfGuard safety sandbox", () => {
  beforeEach(() => {
    resetCuaSelfGuardCaches();
  });

  it("宿主 pid 的调用被拒绝，其他 pid 放行", () => {
    expect(refuseSelfTargetedCall({ pid: SELF_PID }, SELF_PID)).toBe(CUA_SELF_TARGET_REFUSAL);
    expect(refuseSelfTargetedCall({ pid: OTHER_PID }, SELF_PID)).toBeNull();
    expect(refuseSelfTargetedCall({}, SELF_PID)).toBeNull();
    expect(refuseSelfTargetedCall(undefined, SELF_PID)).toBeNull();
  });

  it("拿不到宿主 pid 时不拦截（宁可不拦也不误伤）", () => {
    expect(refuseSelfTargetedCall({ pid: SELF_PID }, null)).toBeNull();
  });

  it("窗口枚举结果剔除宿主记录", () => {
    const payload = JSON.stringify({
      windows: [
        { window_id: 1, pid: SELF_PID, app_name: "ReinAgent" },
        { window_id: 2, pid: OTHER_PID, app_name: "Safari" },
      ],
    });
    const stripped = JSON.parse(stripSelfFromJsonText(payload, SELF_PID));
    expect(stripped.windows.map((w) => w.pid)).toEqual([OTHER_PID]);
  });

  it("过滤时学到的 window_id 让后续按 window_id 的调用也被拦下", () => {
    // 过滤之前拦不住
    expect(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID)).toBeNull();

    stripSelfFromJsonText(
      JSON.stringify([{ window_id: 1, pid: SELF_PID }, { window_id: 2, pid: OTHER_PID }]),
      SELF_PID,
    );

    expect(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID)).toBe(CUA_SELF_TARGET_REFUSAL);
    expect(refuseSelfTargetedCall({ window_id: 2 }, SELF_PID)).toBeNull();
  });

  it("包在 target 里的宿主 pid / window_id 同样被拦下", () => {
    expect(
      refuseSelfTargetedCall({ target: { kind: "window", pid: SELF_PID }, x: 10, y: 10 }, SELF_PID),
    ).toBe(CUA_SELF_TARGET_REFUSAL);
    expect(
      refuseSelfTargetedCall({ target: { kind: "window", pid: OTHER_PID }, x: 10, y: 10 }, SELF_PID),
    ).toBeNull();

    stripSelfFromJsonText(JSON.stringify([{ window_id: 7, pid: SELF_PID }]), SELF_PID);
    expect(refuseSelfTargetedCall({ target: { kind: "window", window_id: 7 } }, SELF_PID)).toBe(
      CUA_SELF_TARGET_REFUSAL,
    );
    expect(refuseSelfTargetedCall({ target: { kind: "window", window_id: 8 } }, SELF_PID)).toBeNull();
  });

  it("桌面坐标判定：显式窗口目标不算，桌面目标与扁平坐标都算", () => {
    expect(usesDesktopScreenCoordinates({ target: { kind: "window", window_id: 9 }, x: 10, y: 10 })).toBe(
      false,
    );
    expect(usesDesktopScreenCoordinates({ target: { kind: "desktop" }, x: 800, y: 400 })).toBe(true);
    expect(usesDesktopScreenCoordinates({ x: 800, y: 400 })).toBe(true);
    expect(usesDesktopScreenCoordinates({ target: { kind: "desktop" } })).toBe(false);
  });

  it("落在宿主窗口矩形内的桌面坐标被拒绝，外面的放行", () => {
    const rects = [{ x: 100, y: 100, width: 400, height: 300 }];

    expect(refuseSelfRegionCall({ target: { kind: "desktop" }, x: 200, y: 200 }, rects)).toBe(
      CUA_SELF_REGION_REFUSAL,
    );
    // 边界算在内
    expect(refuseSelfRegionCall({ x: 100, y: 100 }, rects)).toBe(CUA_SELF_REGION_REFUSAL);
    expect(refuseSelfRegionCall({ x: 500, y: 400 }, rects)).toBe(CUA_SELF_REGION_REFUSAL);

    expect(refuseSelfRegionCall({ x: 900, y: 200 }, rects)).toBeNull();
    expect(refuseSelfRegionCall({ x: 200, y: 900 }, rects)).toBeNull();
  });

  it("嵌套过深的入参被拒绝（防利用深层结构绕过）", () => {
    let deep = { pid: SELF_PID };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(refuseSelfTargetedCall(deep, SELF_PID)).toBe(CUA_SELF_SCAN_DEPTH_REFUSAL);
  });

  it("无明确目标的 desktop 键盘调用在宿主处于前台时被拒绝，前台未知时 fail-closed", () => {
    expect(isDesktopKeyboardCall("press_key", { key: "return" })).toBe(true);
    expect(isDesktopKeyboardCall("hotkey", { keys: ["cmd", "q"] })).toBe(true);
    expect(isDesktopKeyboardCall("type_text", { text: "hello" })).toBe(true);

    // 带了 pid / window_id 的不算
    expect(isDesktopKeyboardCall("press_key", { pid: 123, key: "return" })).toBe(false);

    // 前台是宿主 -> 拒绝
    expect(refuseDesktopKeyboardCall("press_key", { key: "return" }, SELF_PID, SELF_PID)).toBe(
      CUA_SELF_FOREGROUND_REFUSAL,
    );
    // 前台是其他应用 -> 放行
    expect(refuseDesktopKeyboardCall("press_key", { key: "return" }, SELF_PID, OTHER_PID)).toBeNull();
    // 前台未知 -> fail-closed 拒绝
    expect(refuseDesktopKeyboardCall("press_key", { key: "return" }, SELF_PID, null)).toBe(
      CUA_SELF_FOREGROUND_UNKNOWN_REFUSAL,
    );
  });
});
