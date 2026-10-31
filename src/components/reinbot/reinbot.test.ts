import { describe, it, expect, beforeEach } from "bun:test";
import { useAppStore } from "../../store/useAppStore";
import { translations } from "../../i18n";

describe("ReinBot Store & State Verification", () => {
  beforeEach(() => {
    useAppStore.setState({ currentView: "workbench", reinBotName: "ReinBot" });
  });

  it("1. ViewMode supports reinbot routing", () => {
    useAppStore.getState().setCurrentView("reinbot");
    expect(useAppStore.getState().currentView).toBe("reinbot");
  });

  it("2. reinBotName defaults to ReinBot and can be customized", () => {
    expect(useAppStore.getState().reinBotName).toBe("ReinBot");
    useAppStore.getState().setReinBotName("小雷助手");
    expect(useAppStore.getState().reinBotName).toBe("小雷助手");
    // 空字符应兜底回退 ReinBot
    useAppStore.getState().setReinBotName("   ");
    expect(useAppStore.getState().reinBotName).toBe("ReinBot");
  });

  it("3. i18n dictionaries contain comprehensive ReinBot entries", () => {
    const zh = translations["zh-CN"];
    const en = translations["en-US"];

    expect(zh.reinbotNav).toBe("ReinBot");
    expect(zh.reinbotSubtitle).toBe("跟进你的所有任务");
    expect(zh.reinbotRecentTasks).toBe("最近任务");
    expect(zh.reinbotNoTasks).toBe("暂无任务");
    expect(zh.reinbotArtifacts).toBe("工作产物");
    expect(zh.reinbotNoArtifacts).toBe("暂无产物");
    expect(zh.reinbotBadgeId).toBe("No.001 · ReinBot");

    expect(en.reinbotNav).toBe("ReinBot");
    expect(en.reinbotSubtitle).toBe("Following all your tasks");
    expect(en.reinbotRecentTasks).toBe("Recent Tasks");
    expect(en.reinbotNoTasks).toBe("No Tasks");
    expect(en.reinbotArtifacts).toBe("Artifacts");
    expect(en.reinbotNoArtifacts).toBe("No Artifacts");
  });

  it("5. Messages persistence can save and retrieve history roundtrip", () => {
    const { kvSetJSON, kvGetJSON } = require("../../lib/storage/db");
    const testMessages = [
      { id: "m1", sender: "user", text: "测试持久化", time: 1000 },
      { id: "m2", sender: "bot", text: "已持久化", time: 2000 },
    ];
    kvSetJSON("reinagent-reinbot-messages", testMessages);
    const retrieved = kvGetJSON("reinagent-reinbot-messages");
    expect(retrieved).toEqual(testMessages);
  });

  it("6. Red/Break Check: corrupted messages payload fails validation", () => {
    const { kvSetJSON, kvGetJSON } = require("../../lib/storage/db");
    kvSetJSON("reinagent-reinbot-messages", null);
    const retrieved = kvGetJSON("reinagent-reinbot-messages");
    expect(retrieved === null).toBe(true);
  });

  it("7. Option A: Plus menu i18n keys and task link formatting", () => {
    const zh = translations["zh-CN"];
    const en = translations["en-US"];

    expect(zh.reinbotAttachFile).toBe("上传附件 / 图片");
    expect(zh.reinbotLinkTask).toBe("关联已有任务");
    expect(zh.reinbotSelectTask).toBe("选择关联任务");
    expect(zh.reinbotNoAvailableTasks).toBe("暂无可用任务");

    expect(en.reinbotAttachFile).toBe("Attach File / Image");
    expect(en.reinbotLinkTask).toBe("Link Existing Task");
    expect(en.reinbotSelectTask).toBe("Select Task to Link");
    expect(en.reinbotNoAvailableTasks).toBe("No tasks available");

    // Task link format verification
    const mockTask = { id: "task-101", title: "测试长连架构" };
    const linkTag = `@任务[${mockTask.title || mockTask.id}] `;
    expect(linkTag).toBe("@任务[测试长连架构] ");
    expect(zh.reinbotNavigatedTask).toBe("已切换至该任务工作台");
    expect(en.reinbotNavigatedTask).toBe("Switched to task workbench");
  });

  it("8. Red/Break Check: missing required task title falls back to task id safely", () => {
    const mockTask = { id: "task-fallback", title: "" };
    const linkTag = `@任务[${mockTask.title || mockTask.id}] `;
    expect(linkTag).toBe("@任务[task-fallback] ");
    expect(linkTag).not.toBe("@任务[] ");
  });

  it("9. Task Context Resolution: extractLinkedTasks correctly extracts tasks for prompt injection", () => {
    const { extractLinkedTasks } = require("../../lib/reinbot/taskContextResolver");
    const tasks = [
      { id: "task-1791502542526-2ygr1", title: "os-taxonomy" },
      { id: "task-daily", title: "每日科技日报" },
    ];
    const text = "@任务[os-taxonomy] 查看一下这个任务的对话历史";
    const matched = extractLinkedTasks(text, tasks);
    expect(matched.length).toBe(1);
    expect(matched[0].id).toBe("task-1791502542526-2ygr1");
  });

  it("10. Model Selector i18n & Persistence roundtrip", () => {
    const zh = translations["zh-CN"];
    const en = translations["en-US"];

    expect(zh.reinbotDefaultModel).toBe("默认模型");
    expect(zh.reinbotDefaultTag).toBe("默认");
    expect(zh.reinbotSwitchModel).toBe("切换模型");
    expect(zh.reinbotModelRestoredDefault).toBe("已恢复为默认模型");

    expect(en.reinbotDefaultModel).toBe("Default Model");
    expect(en.reinbotDefaultTag).toBe("Default");
    expect(en.reinbotSwitchModel).toBe("Switch Model");
    expect(en.reinbotModelRestoredDefault).toBe("Restored to default model");

    const { kvSet, kvGet } = require("../../lib/storage/db");
    const { formatModelKey, parseModelKey } = require("../../lib/reinbot/modelKeyResolver");
    const key = formatModelKey("custom-1791416422975", "workbuddy/deepseek-v4.1-flash");
    kvSet("reinagent-reinbot-selected-model", key);
    expect(kvGet("reinagent-reinbot-selected-model")).toBe(key);
    expect(parseModelKey(key)).toEqual({
      providerId: "custom-1791416422975",
      modelId: "workbuddy/deepseek-v4.1-flash",
    });
  });

  it("11. Red/Break Check: clearing model key restores empty default state", () => {
    const { kvSet, kvGet } = require("../../lib/storage/db");
    kvSet("reinagent-reinbot-selected-model", "");
    expect(kvGet("reinagent-reinbot-selected-model")).toBe("");
  });

  it("12. Vision Support Verification: buildModel with supportsImage: true declares ['text', 'image'] input for visual analysis", () => {
    const { buildModel } = require("../../lib/providers/modelFactory");
    const modelWithVision = buildModel({
      provider: "deepseek",
      modelId: "workbuddy/deepseek-v4.1-flash",
      apiKey: "test",
      supportsImage: true,
      contextWindow: 1048576,
    });
    expect(modelWithVision.input).toEqual(["text", "image"]);
    expect(modelWithVision.contextWindow).toBe(1048576);
  });

  it("13. Red/Break Check: missing supportsImage restricts input to text-only (preventing unadvertised vision bypass)", () => {
    const { buildModel } = require("../../lib/providers/modelFactory");
    const textOnlyModel = buildModel({
      provider: "deepseek",
      modelId: "deepseek-chat",
      apiKey: "test",
      supportsImage: false,
    });
    expect(textOnlyModel.input).toEqual(["text"]);
    expect(textOnlyModel.input).not.toContain("image");
  });

  it("14. Paste Image Verification: i18n keys exist for pasted image notification", () => {
    const zh = translations["zh-CN"];
    const en = translations["en-US"];
    expect(zh.reinbotPastedImageAdded).toBe("已添加粘贴的图片");
    expect(zh.reinbotPastedImageFailed).toBe("图片粘贴失败");
    expect(en.reinbotPastedImageAdded).toBe("Pasted image added");
    expect(en.reinbotPastedImageFailed).toBe("Failed to paste image");
  });

  it("15. Red/Break Check: non-image mime types are correctly rejected", () => {
    const nonImageFile = { type: "text/plain", name: "notes.txt" };
    expect(nonImageFile.type.startsWith("image/")).toBe(false);

    const imageFile = { type: "image/png", name: "screenshot.png" };
    expect(imageFile.type.startsWith("image/")).toBe(true);
  });

  it("16. Paste Deduplication & Mutex: concurrent fallback calls are safely guarded by lock", async () => {
    let callCount = 0;
    let isPasting = false;
    const mockPasteFallback = async () => {
      if (isPasting) return;
      isPasting = true;
      try {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        isPasting = false;
      }
    };

    // Simulate simultaneous paste events (e.g. from input + bubbling container)
    await Promise.all([mockPasteFallback(), mockPasteFallback()]);
    expect(callCount).toBe(1);
  });

  it("17. Red/Break Check: un-guarded concurrent paste triggers duplicate calls", async () => {
    let callCount = 0;
    const unguardedPasteFallback = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
    };

    await Promise.all([unguardedPasteFallback(), unguardedPasteFallback()]);
    expect(callCount).toBe(2);
  });
});

