import http from "node:http";
import fs from "node:fs";

const HOST = process.env.REINAGENT_HOST || "192.168.3.27";
const PORT = parseInt(process.env.REINAGENT_PORT || "7777", 10);
const TOKEN = process.env.REINAGENT_TOKEN || "508ba64c24664b369d2114bc18356022";
const TASK_ID = process.env.REINAGENT_TASK_ID || "task-1792414088636-h92ti";

let directive = "";
if (process.argv[2]) {
  if (process.argv[2].startsWith("@")) {
    directive = fs.readFileSync(process.argv[2].slice(1), "utf-8");
  } else {
    directive = process.argv.slice(2).join(" ");
  }
} else {
  directive = `【终极突破：field7 已 100% 离线复现成功！Tag 逐字节完全匹配！】

### 1. 为什么你之前算不对 Tag？（规范版本差异）
- 你的 Nonce 结论完全正确：无需任何位变换，直接就是 \`xxh64(arg0, seed=j1)\` 的 8 字节小端序（之前是我多算了一次雪崩末步的异或）。
- \`libcore.so\` 链接的 \`crypto_aead_chacha20poly1305_encrypt_detached\` 是 **libsodium 原始版（即 draft-agl-tls-chacha20poly1305 规范）**，而不是后来的 RFC 7539 / IETF 规范！
- 两者的致命差异在 Poly1305 的输入结构：
  - RFC 7539 (IETF) 要求 16 字节对齐填充：\`pad16(ad) || pad16(ct)\`
  - 而 libsodium 原版（draft-agl）**严格不填充任何零字节**，直接拼接长度：
    \`poly_input = ad + pack("<Q", len(ad)) + ciphertext + pack("<Q", len(ciphertext))\`

### 2. 本地已 100% 验证通过的完整纯算法（与你的样本 62b402a2 逐字节一致）：

\`\`\`python
import struct
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
from cryptography.hazmat.primitives.poly1305 import Poly1305

def build_aead_cipher_and_tag(projectPk: bytes, nonce8: bytes, j2: int, plaintext: bytes):
    ad = struct.pack("<Q", j2)
    
    # 1. 用 counter=0 生成 64 字节块，前 32 字节作为 Poly1305 Key
    cipher = Cipher(algorithms.ChaCha20(projectPk, b"\\x00" * 8 + nonce8), mode=None).encryptor()
    block0 = cipher.update(b"\\x00" * 64)
    poly_key = block0[:32]
    
    # 2. 从 counter=1 开始加密明文
    ciphertext = cipher.update(plaintext)
    
    # 3. draft-agl 规范 Poly1305 Tag 计算（无 zero-padding！）
    mac_data = ad + struct.pack("<Q", len(ad)) + ciphertext + struct.pack("<Q", len(ciphertext))
    tag = Poly1305.generate_tag(poly_key, mac_data)
    
    return ciphertext, tag
\`\`\`

实测结果：
- 密文：\`9df5a6a41993fbc94f52ce\`（100% 吻合）
- Tag（field7）：\`62b402a284db199b08ffcec45c964536\`（100% 吻合，与你的实测值完全一致！）

### 3. 本轮任务
1. **无需起 unidbg，无需在雷电模拟器挂任何 hook**，直接使用上述纯算法。
2. 将此完整算法固化进 \`python/wangshangliao/protocol.py\`。
3. 补齐 \`bot/src/protocol/wsl-proto.ts\` 的 TypeScript 实现（用既有的 ChaCha20 和 Poly1305）。
4. 运行现有 8 组样本的全量回归测试，全部变绿后向项目管理员汇报！`;
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
