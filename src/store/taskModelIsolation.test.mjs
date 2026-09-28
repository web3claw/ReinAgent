import { test, after } from "node:test";
import assert from "node:assert/strict";

// Mock localStorage and window in global scope for testing useAppStore。
// ⚠️ bun test 单进程跑全部文件：这里的全局 mock 若不恢复，会污染后续测试文件
// （如 tools.test.mjs 的「Node 下 window is not defined」对照断言）——after 中还原。
const storageMap = new Map();
const realWindow = globalThis.window;
const realLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem: (key) => storageMap.get(key) ?? null,
  setItem: (key, val) => storageMap.set(key, String(val)),
  removeItem: (key) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
globalThis.window = globalThis;
after(() => {
  if (realWindow === undefined) delete globalThis.window;
  else globalThis.window = realWindow;
  if (realLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = realLocalStorage;
});

test("独立任务窗口模型记忆：不同任务可以分别设置并记忆不同的模型，互不干扰", async () => {
  storageMap.clear();

  // 动态导入 useAppStore
  const { useAppStore } = await import("./useAppStore.ts");

  // 1. 创建任务 A，初始指定模型 provider-a:model-a
  const taskIdA = useAppStore.getState().createTask("Task A", null, "provider-a", "model-a");
  assert.equal(useAppStore.getState().activeTaskId, taskIdA);

  const taskA = useAppStore.getState().tasks.find((t) => t.id === taskIdA);
  assert.equal(taskA?.providerId, "provider-a");
  assert.equal(taskA?.modelId, "model-a");

  // 2. 创建任务 B，初始指定模型 provider-b:model-b
  const taskIdB = useAppStore.getState().createTask("Task B", null, "provider-b", "model-b");
  assert.equal(useAppStore.getState().activeTaskId, taskIdB);

  const taskB = useAppStore.getState().tasks.find((t) => t.id === taskIdB);
  assert.equal(taskB?.providerId, "provider-b");
  assert.equal(taskB?.modelId, "model-b");

  // 检查任务 A 的模型是否依然保持为 provider-a:model-a（未被任务 B 干扰）
  const taskACheck = useAppStore.getState().tasks.find((t) => t.id === taskIdA);
  assert.equal(taskACheck?.providerId, "provider-a");
  assert.equal(taskACheck?.modelId, "model-a");

  // 3. 在任务 A 中切换模型为 provider-c:model-c
  useAppStore.getState().setActiveTaskId(taskIdA);
  useAppStore.getState().updateTaskModel(taskIdA, "provider-c", "model-c");

  const taskAUpdated = useAppStore.getState().tasks.find((t) => t.id === taskIdA);
  assert.equal(taskAUpdated?.providerId, "provider-c");
  assert.equal(taskAUpdated?.modelId, "model-c");

  // 确认任务 B 仍然不受影响
  const taskBCheck = useAppStore.getState().tasks.find((t) => t.id === taskIdB);
  assert.equal(taskBCheck?.providerId, "provider-b");
  assert.equal(taskBCheck?.modelId, "model-b");

  // 4. 持久化已迁移至 SQLite（conversations.db tasks 表），localStorage 键
  //    "reinagent-tasks" 不复存在——隔离语义以上方状态断言为准，此处不再断言旧键。
});
