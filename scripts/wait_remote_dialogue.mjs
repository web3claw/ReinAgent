import http from "node:http";

const posArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const HOST = process.env.REINAGENT_HOST || posArgs[0] || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || posArgs[1] || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || posArgs[2] || "508ba64c24664b369d2114bc18356022";
let targetTaskId = process.env.REINAGENT_TASK_ID || posArgs[3] || "";
const CHECK_INTERVAL_MINS = parseFloat(process.env.REINAGENT_CHECK_INTERVAL_MINS || posArgs[4] || "10");
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINS * 60 * 1000;

console.log(`[WAIT-DAEMON] Initializing with HOST=${HOST}:${PORT}, CHECK_INTERVAL=${CHECK_INTERVAL_MINS}m...`);

let sessionId = null;
const pendingCalls = new Map();
let rpcId = 1;

function sendPost(path, body) {
  return new Promise((resolve, reject) => {
    const postReq = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let respData = "";
        res.on("data", (d) => (respData += d));
        res.on("end", () => resolve(respData));
      }
    );
    postReq.on("error", reject);
    postReq.write(body);
    postReq.end();
  });
}

function callRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = rpcId++;
    pendingCalls.set(id, { resolve, reject });
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    sendPost(`/mcp/message?session_id=${sessionId}&token=${TOKEN}`, payload).catch(reject);
  });
}

async function callTool(name, args = {}) {
  return callRpc("tools/call", { name, arguments: args });
}

let buffer = "";
let connectionErrorCount = 0;

const req = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: `/mcp/sse?token=${TOKEN}`,
    method: "GET",
    headers: { Accept: "text/event-stream" },
  },
  (res) => {
    res.on("data", async (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop();

      for (const block of parts) {
        if (!block.trim()) continue;
        if (!sessionId && block.includes("event: endpoint")) {
          const match = block.match(/data: \/mcp\/message\?session_id=([a-f0-9\-]+)/);
          if (match) {
            sessionId = match[1];
            startWatchLoop().catch((err) => {
              console.error("[WAIT-DAEMON] Fatal loop error:", err);
              process.exit(1);
            });
          }
        } else if (block.includes("event: message")) {
          const match = block.match(/data: (\{.*\})/s);
          if (match) {
            try {
              const msg = JSON.parse(match[1]);
              const pending = pendingCalls.get(msg.id);
              if (pending) {
                pendingCalls.delete(msg.id);
                pending.resolve(msg);
              }
            } catch (e) {
              console.error("[WAIT-DAEMON] JSON parse err:", e);
            }
          }
        }
      }
    });
  }
);

req.on("error", (e) => {
  console.error("[WAIT-DAEMON] SSE connection error:", e);
  console.log("\n=======================================================");
  console.log(">>> [ANOMALY-ALERT: CRASH] 远程服务器连接中断或已崩溃 <<<");
  console.log("=======================================================\n");
  process.exit(0);
});

req.end();

function extractMessagesSummary(messages, maxCount = 3) {
  if (!messages || messages.length === 0) return "（无消息记录）";
  const slice = messages.slice(-maxCount);
  let summary = "";
  for (const msg of slice) {
    summary += `\n[Role: ${msg.role}]\n`;
    for (const p of msg.parts || []) {
      try {
        const pData = JSON.parse(p.payload);
        if (pData.text) summary += `  文本: ${pData.text.slice(0, 300)}...\n`;
        if (pData.thinking) summary += `  思考片段: ${pData.thinking.slice(0, 200)}...\n`;
        if (pData.toolName) summary += `  调用工具: ${pData.toolName}(${JSON.stringify(pData.args || {}).slice(0, 100)})\n`;
        if (pData.error) summary += `  ⚠️ 工具报错: ${pData.error.slice(0, 200)}\n`;
      } catch (_) {
        summary += `  ${p.type}: ${(p.payload || "").slice(0, 150)}...\n`;
      }
    }
  }
  return summary;
}

function checkDeadLoop(messages) {
  if (!messages || messages.length < 3) return null;

  // 仅检测当前回合（最新一条 user 消息之后产生的内容），避免历史回合历史调用误报
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const currentTurnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages.slice(-10);
  if (currentTurnMessages.length < 3) return null;

  const recentCalls = [];
  for (const m of currentTurnMessages) {
    for (const p of m.parts || []) {
      try {
        const pData = JSON.parse(p.payload);
        if (pData.toolName) {
          recentCalls.push({
            name: pData.toolName,
            args: JSON.stringify(pData.args || {}),
            error: pData.error,
          });
        }
      } catch (_) {}
    }
  }
  if (recentCalls.length >= 3) {
    const tail3 = recentCalls.slice(-3);
    const allSameName = tail3.every((c) => c.name === tail3[0].name);
    const hasValidArgs = tail3[0].args && tail3[0].args !== "{}" && tail3[0].args !== "null";
    const allSameArgs = tail3.every((c) => c.args === tail3[0].args);
    if (allSameName && hasValidArgs && allSameArgs) {
      return `连续 3 次调用相同工具与参数: ${tail3[0].name} (${tail3[0].args.slice(0, 80)})`;
    }
    const allErrors = tail3.every((c) => !!c.error);
    if (allErrors && allSameName) {
      return `连续 3 次工具执行失败: ${tail3[0].name}`;
    }
  }
  return null;
}

async function startWatchLoop() {
  await callRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ReinAgentDialogueDaemon", version: "1.1.0" },
  });

  console.log("[WAIT-DAEMON] Initialized MCP session:", sessionId);

  // If no task_id provided, query active tasks
  if (!targetTaskId) {
    console.log("[WAIT-DAEMON] No task_id specified. Auto-detecting active task...");
    const listRes = await callTool("reinagent_list_tasks", {});
    try {
      const raw = JSON.parse(listRes.result?.content?.[0]?.text || "{}");
      const taskList = Array.isArray(raw) ? raw : (raw.tasks || []);
      const runningTask = taskList.find((t) => t.displayStatus === "running" || t.running);
      const activeTask = taskList.find((t) => (t.taskId || t.id) === raw.activeTaskId);
      const chosen = runningTask || activeTask || taskList[0];
      if (chosen) {
        targetTaskId = chosen.taskId || chosen.id;
        console.log(`[WAIT-DAEMON] Auto-selected task: ${targetTaskId} (status=${chosen.displayStatus || chosen.running})`);
      } else {
        console.error("[WAIT-DAEMON] No tasks found on remote ReinAgent.");
        process.exit(1);
      }
    } catch (e) {
      console.error("[WAIT-DAEMON] Failed to list tasks:", e);
      process.exit(1);
    }
  }

  console.log(`[WAIT-DAEMON] Monitoring task [${targetTaskId}] (Periodic check: ${CHECK_INTERVAL_MINS}m)...`);

  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let startSeq = null;
  let startMsgCount = null;
  let lastSeq = null;
  let pollCount = 0;
  let hasSeenRunning = false;

  while (true) {
    pollCount++;
    let res;
    try {
      res = await callTool("reinagent_get_task_status", {
        task_id: targetTaskId,
        limit: 10,
      });
      connectionErrorCount = 0;
    } catch (err) {
      connectionErrorCount++;
      console.error(`[WAIT-DAEMON] Status fetch failed (${connectionErrorCount}/5):`, err.message || err);
      if (connectionErrorCount >= 5) {
        console.log("\n=======================================================");
        console.log(">>> [ANOMALY-ALERT: CRASH] 连续 5 次获取任务状态失败，远程服务疑似中断 <<<");
        console.log("=======================================================\n");
        req.destroy();
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    try {
      const data = JSON.parse(res.result?.content?.[0]?.text || "{}");
      const isRunning = data.running === true;
      const lastMsgSeq = data.messages?.[data.messages.length - 1]?.seq;
      const currentSeq = data.revision ?? lastMsgSeq ?? data.totalMessages ?? 0;
      const currentMsgCount = data.totalMessages ?? data.messages?.length ?? 0;

      const waitForNewTurn = process.env.WAIT_NEW_TURN === "1" || process.argv.includes("--wait-new-turn");

      if (isRunning) hasSeenRunning = true;

      if (startSeq === null) startSeq = currentSeq;
      if (startMsgCount === null) startMsgCount = currentMsgCount;

      // 活跃度与序号递增检测
      if (lastSeq === null || currentSeq > lastSeq) {
        lastSeq = currentSeq;
        lastActivityTime = Date.now();
      }

      if (pollCount % 10 === 0) {
        const elapsedMins = ((Date.now() - startTime) / 60000).toFixed(1);
        console.log(`[WAIT-DAEMON] Heartbeat: elapsed=${elapsedMins}m, msgs=${currentMsgCount}, running=${isRunning}, waitForNewTurn=${waitForNewTurn}`);
      }

      // 如果开启了等待新回合模式，且尚未看到任务启动且消息条数未增加，则持续等待外部触发
      if (waitForNewTurn && !hasSeenRunning && !isRunning && currentMsgCount <= startMsgCount) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // 如果尚未看到任务运行且处于前 10 次轮询（20秒内），等待任务启动
      if (!isRunning && !hasSeenRunning && pollCount <= 10) {
        console.log(`[WAIT-DAEMON] Task is currently not running. Waiting for startup (check ${pollCount}/10)...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // 1. 通道一：任务正常完成
      if (!isRunning) {
        console.log("\n=======================================================");
        console.log(">>> [EVENT] 远程 REINAGENT 会话完成！(Turn Completed) <<<");
        console.log("=======================================================\n");

        if (data.messages && data.messages.length > 0) {
          const lastMsg = data.messages[data.messages.length - 1];
          let foundText = "";
          for (const p of lastMsg.parts || []) {
            try {
              const pData = JSON.parse(p.payload);
              if (pData.text) foundText += pData.text + "\n";
              if (Array.isArray(pData.content)) {
                for (const item of pData.content) {
                  if (item.text) foundText += item.text + "\n";
                }
              }
              if (pData.errorMessage) foundText += `[Error: ${pData.errorMessage}]\n`;
            } catch (_) {}
          }
          if (foundText.trim()) {
            console.log("[REMOTE AGENT 汇报内容]:\n" + foundText.trim());
          } else if (lastMsg.error) {
            console.log("[REMOTE AGENT 错误]:\n" + lastMsg.error);
          }
        }
        console.log("\n>>> 请本端项目管理员立即做出决策并发送回复！<<<\n");
        req.destroy();
        process.exit(0);
      }

      // 2. 通道二：硬性异常检测（死循环与僵死）
      const deadLoopReason = checkDeadLoop(data.messages);
      if (deadLoopReason) {
        console.log("\n=======================================================");
        console.log(">>> [ANOMALY-ALERT: DEADLOOP] 监测到任务死循环！<<<");
        console.log(`原因: ${deadLoopReason}`);
        console.log("=======================================================\n");
        console.log("近期会话快照:\n", extractMessagesSummary(data.messages, 3));
        console.log("\n>>> 请本端项目管理员立即介入纠偏或强停任务！<<<\n");
        req.destroy();
        process.exit(0);
      }

      const idleDurationMs = Date.now() - lastActivityTime;
      if (idleDurationMs >= CHECK_INTERVAL_MS) {
        console.log("\n=======================================================");
        console.log(`>>> [ANOMALY-ALERT: FROZEN] 任务已超过 ${CHECK_INTERVAL_MINS} 分钟完全无推进 (Seq: ${currentSeq})！<<<`);
        console.log("=======================================================\n");
        console.log("近期会话快照:\n", extractMessagesSummary(data.messages, 3));
        console.log("\n>>> 请本端项目管理员立即介入排查是否死锁挂起！<<<\n");
        req.destroy();
        process.exit(0);
      }

      // 3. 通道三：满 10 分钟周期巡检（业务方向评估）
      const totalElapsedMs = Date.now() - startTime;
      if (totalElapsedMs >= CHECK_INTERVAL_MS) {
        console.log("\n=======================================================");
        console.log(`>>> [PERIODIC-CHECK] 任务已稳定运行满 ${CHECK_INTERVAL_MINS} 分钟，当前仍在推进中 <<<`);
        console.log(`>>> 状态健康：无死循环、无僵死（Seq 从 ${startSeq} 递增至 ${currentSeq}）<<<`);
        console.log("=======================================================\n");
        console.log("[近 10 分钟执行与思考摘要]:\n", extractMessagesSummary(data.messages, 3));
        console.log("\n>>> 请本端项目管理员评估任务方向是否跑偏。若正常，自动续挂下一个 10 分钟守护 <<<");
        req.destroy();
        process.exit(0);
      }
    } catch (e) {
      console.error("[WAIT-DAEMON] Status parse err:", e);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}
