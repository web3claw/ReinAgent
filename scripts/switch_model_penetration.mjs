import http from "node:http";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";
const TARGET_TASK_ID = process.argv[2] || "task-1792559574495-0s0qo";
const PROVIDER_ID = "custom-1791417182102"; // Magpie
const MODEL_ID = process.argv[3] || "trae-cn/glm-5.3-flash-max";

let sessionId = null;
let rpcId = 1;
const pendingCalls = new Map();

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
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (!sessionId && dataStr.startsWith("/mcp/message?session_id=")) {
            sessionId = dataStr.split("session_id=")[1].split("&")[0];
            console.log(`[Init] Connected to ${HOST}:${PORT}, session: ${sessionId}`);
            try {
              await callRpc("initialize", {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "ModelPenetrationSwitch", version: "1.0.0" },
              });

              // 1. 获取任务列表找跳板
              console.log("[1/5] Listing tasks to find springboard task...");
              const tasksResp = await callTool("reinagent_list_tasks", {});
              const tasksText = tasksResp.result?.content?.[0]?.text;
              const tasksData = tasksText ? JSON.parse(tasksText) : [];
              const tasks = Array.isArray(tasksData) ? tasksData : (tasksData.tasks || []);
              const springboardTask = tasks.find((t) => (t.id || t.taskId) !== TARGET_TASK_ID);
              const springboardId = springboardTask ? (springboardTask.id || springboardTask.taskId) : null;
              console.log(`Springboard task: ${springboardId}`);

              // 2. 绑定当前任务模型
              console.log(`[2/5] Binding task model for ${TARGET_TASK_ID} to ${PROVIDER_ID}:${MODEL_ID}...`);
              const setTaskRet = await callTool("reinagent_set_model", {
                task_id: TARGET_TASK_ID,
                provider_id: PROVIDER_ID,
                model_id: MODEL_ID,
              });
              console.log("Set task model ret:", JSON.stringify(setTaskRet.result || setTaskRet));

              // 3. 绑定全局默认模型
              console.log(`[3/5] Binding global default model to ${PROVIDER_ID}:${MODEL_ID}...`);
              const setGlobalRet = await callTool("reinagent_set_model", {
                task_id: null,
                provider_id: PROVIDER_ID,
                model_id: MODEL_ID,
              });
              console.log("Set global model ret:", JSON.stringify(setGlobalRet.result || setGlobalRet));

              // 4. 跳板切换
              if (springboardId) {
                console.log(`[4/5] Switching to springboard task ${springboardId}...`);
                await callTool("reinagent_switch_task", { task_id: springboardId });
                await new Promise((r) => setTimeout(r, 600));

                console.log(`[5/5] Switching BACK to target task ${TARGET_TASK_ID}...`);
                await callTool("reinagent_switch_task", { task_id: TARGET_TASK_ID });
                await new Promise((r) => setTimeout(r, 600));
              } else {
                console.log("[4/5] No second task found, skipping switch step.");
              }

              console.log("=== TRIPLE-PENETRATION SWITCH COMPLETED SUCCESSFULLY ===");
              setTimeout(() => process.exit(0), 500);
            } catch (err) {
              console.error("Switch error:", err);
              process.exit(1);
            }
          } else if (dataStr.startsWith("{")) {
            try {
              const msg = JSON.parse(dataStr);
              if (msg.id && pendingCalls.has(msg.id)) {
                const { resolve, reject } = pendingCalls.get(msg.id);
                pendingCalls.delete(msg.id);
                if (msg.error) reject(msg.error);
                else resolve(msg);
              }
            } catch (_) {}
          }
        }
      }
    });
  }
);

req.on("error", (err) => {
  console.error("SSE connection error:", err);
  process.exit(1);
});
req.end();
