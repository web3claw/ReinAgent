# ReinAgent Project Memory & Guidelines

## 1. Reference Codebases (严禁反编译，直接查阅本地源码)

每次研究或查找实现原理、组件样式、交互模式及底层架构时，**直接查阅以下源码目录，严禁反编译或反解已打包文件**：

1. **ZCode 源码**:
   - 路径：`/home/web3claw/DevCode/ReinAgent/ZCode`
   - UI 组件库：`/home/web3claw/DevCode/ReinAgent/ZCode/packages/ui/`
   - 核心前端与功能：`/home/web3claw/DevCode/ReinAgent/ZCode/packages/`、`/home/web3claw/DevCode/ReinAgent/ZCode/apps/`

2. **LiveAgent 源码**:
   - 路径：`/home/web3claw/DevCode/ReinAgent/LiveAgent`
   - 核心与 Rust / Tauri 后端：`/home/web3claw/DevCode/ReinAgent/LiveAgent/crates/`
   - 前端与客户端实现：`/home/web3claw/DevCode/ReinAgent/LiveAgent/`

---

## 2. Requirement Confirmation & Workflow Rule (需求前置确认铁律)

- **接收到用户发送的任何开发需求时，严禁直接动手写代码**。
- **必须先进行需求分析与要点整理，输出清晰的需求明细发给用户确认**。
- **只有在得到用户的明确确认回复后，方可进入实际编码开发阶段**。

---

## 3. Linux Compilation & Execution Environment (run-linux.sh 专用配置记忆)

由于当前开发环境可能处于网络共享盘/虚拟挂载目录（CIFS/SMB 文件系统不支持 Linux 符号链接及文件锁），因此**本机的编译、前端启动与 Tauri 开发运行必须严格遵循 `run-linux.sh` 的环境隔离配置**：

1. **工作区隔离目录**：
   - 运行与编译工作区：`/tmp/reinagent`
   - Rust 编译缓存目录：`TARGET_DIR="/tmp/reinagent/target"`（通过环境变量 `export CARGO_TARGET_DIR="$TARGET_DIR"` 指定）
   - 原生依赖路径：`/tmp/reinagent/node_modules`（在 `/tmp` 下执行 `bun install` 生成，避免网络盘软链接失败）
2. **源码同步机制**：
   - 每次编译或运行前，通过 `rsync` 将源码同步到 `/tmp/reinagent/`：
     ```bash
     rsync -av --delete --exclude 'node_modules' --exclude 'target' --exclude '.git' "$PROJECT_DIR/" "/tmp/reinagent/"
     ```
3. **前端构建与测试验证**：
   - 验证构建必须在本地环境运行：
     ```bash
     rsync -av --delete --exclude 'node_modules' --exclude 'target' --exclude '.git' /home/web3claw/DevCode/ReinAgent/ReinAgent/ /tmp/reinagent/ && cd /tmp/reinagent && bun run build
     ```
4. **启动服务机制**：
   - 前端 Vite 运行在端口 `1420`：`(cd /tmp/reinagent && bun /tmp/reinagent/node_modules/vite/bin/vite.js --port 1420) &`
   - Tauri 桌面启动命令：`cd "$PROJECT_DIR" && cargo tauri dev -c '{"build": {"beforeDevCommand": ""}}'`

---

## 4. Project Context & Real-time Update Rule (核心文档实时同步规范)

项目的系统设计分层、组件职责、状态流转、持久化键名及交互细节，完整记录在：
👉 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)

### ⚠️ 铁律规范（必须严格遵守）：
1. **优先查阅**：接手开发或执行任务前，**必须优先通读 `PROJECT_CONTEXT.md`** 获取最精准的开发上下文与设计规范。
2. **及时同步更新**：**后续完成任何功能迭代、架构调整、新增组件或变更存储键名后，必须第一时间同步更新 `PROJECT_CONTEXT.md`**，确保该文档始终作为全项目的**最新单点真相（Single Source of Truth）**，严禁出现代码更新而文档滞后的情况。
