import http from "node:http";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";
const TASK_ID = process.argv[2] || "task-1792559574495-0s0qo";
const DIRECTIVE = process.argv[3];

if (!DIRECTIVE) {
  console.error("Usage: node send_directive.mjs <taskId> <directive>");
  process.exit(1);
}

let sessionId = null;
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
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    sendPost(`/mcp/message?session_id=${sessionId}&token=${TOKEN}`, payload).catch(reject);
  });
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
          if (dataStr.startsWith("/mcp/message?session_id=")) {
            sessionId = dataStr.split("session_id=")[1].split("&")[0];
            console.log(`[Directive] Connected! Sending directive to task ${TASK_ID}...`);
            try {
              // 先发送 initialize 握手
              await sendPost(`/mcp/message?session_id=${sessionId}&token=${TOKEN}`, JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId++,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: { name: "ReinAgentDirectiveSender", version: "1.0.0" }
                }
              }));
              // 发送 reinagent_send_message
              await sendPost(`/mcp/message?session_id=${sessionId}&token=${TOKEN}`, JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId++,
                method: "tools/call",
                params: {
                  name: "reinagent_send_message",
                  arguments: {
                    task_id: TASK_ID,
                    text: DIRECTIVE
                  }
                }
              }));
              console.log("[Directive] Sent successfully via reinagent_send_message!");
              setTimeout(() => process.exit(0), 1000);
            } catch (err) {
              console.error("[Directive] Send failed:", err);
              process.exit(1);
            }
          }
        }
      }
    });
  }
);

req.on("error", err => {
  console.error("SSE connection error:", err);
  process.exit(1);
});
req.end();
