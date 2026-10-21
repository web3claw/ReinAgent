import http from "node:http";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";

const toolName = process.argv[2];
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

if (!toolName) {
  console.error("Usage: node reinagent_mcp_client.mjs <toolName> [jsonArgs]");
  process.exit(1);
}

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
        if (line.startsWith("event: endpoint")) {
          // next data has endpoint
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (dataStr.startsWith("/mcp/message?session_id=")) {
            sessionId = dataStr.split("session_id=")[1].split("&")[0];
            callRpc("tools/call", { name: toolName, arguments: toolArgs })
              .then(result => {
                console.log(JSON.stringify(result, null, 2));
                process.exit(0);
              })
              .catch(err => {
                console.error("Tool execution error:", err);
                process.exit(1);
              });
          } else {
            try {
              const msg = JSON.parse(dataStr);
              if (msg.id && pendingCalls.has(msg.id)) {
                const { resolve, reject } = pendingCalls.get(msg.id);
                pendingCalls.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
              }
            } catch (e) {
              // ignore unparseable
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
