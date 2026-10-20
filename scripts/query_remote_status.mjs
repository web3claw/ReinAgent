import http from "node:http";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";
const TASK_ID = process.env.REINAGENT_TASK_ID || "task-1792414088636-h92ti";

console.log(`Connecting to remote ReinAgent at ${HOST}:${PORT}...`);

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
            doQuery().catch((e) => {
              console.error("doQuery error:", e);
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
              console.error("JSON parse err:", e);
            }
          }
        }
      }
    });
  }
);

req.on("error", (e) => {
  console.error("SSE error:", e);
  process.exit(1);
});

req.end();

async function doQuery() {
  await callRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "AntigravityPM", version: "1.0.0" },
  });

  console.log("Initialized session:", sessionId);
  const stopRes = await callTool("reinagent_stop_task", { task_id: "task-1792414088636-h92ti" });
  console.log("Stop task result:", JSON.stringify(stopRes.result, null, 2));

  req.destroy();
  process.exit(0);
}
