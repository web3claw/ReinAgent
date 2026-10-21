import http from "node:http";
import fs from "node:fs";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";
let TASK_ID = process.env.REINAGENT_TASK_ID || "task-1792559574495-0s0qo";

let directive = "";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--task" && args[i + 1]) {
    TASK_ID = args[i + 1];
    args.splice(i, 2);
    i--;
  }
}

if (args[0]) {
  if (args[0].startsWith("@")) {
    directive = fs.readFileSync(args[0].slice(1), "utf-8");
  } else {
    directive = args.join(" ");
  }
} else {
  console.error("Usage: node send_directive.mjs [--task <taskId>] <directive text | @file_path>");
  process.exit(1);
}

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
            doSend().catch((e) => {
              console.error("doSend error:", e);
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

async function doSend() {
  await callRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "AntigravityPM", version: "1.0.0" },
  });

  console.log("Initialized session:", sessionId);
  console.log(`Sending steering prompt to task ${TASK_ID}...`);

  const res = await callTool("reinagent_send_message", {
    task_id: TASK_ID,
    text: directive,
  });

  console.log("Response:", JSON.stringify(res.result));
  req.destroy();
  process.exit(0);
}
