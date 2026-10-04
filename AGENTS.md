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

## 3. Linux Compilation & Execution Environment (编译与运行规范)

编译测试/运行验证**由 Agent 执行**，命令（仓库根目录）：

```bash
bun run tauri dev
```

**正式发布构建 `bun run tauri build` 由用户本人运行，Agent 严禁代跑**（避免长时间占用构建产物与 bundle 目录）。

- 依赖安装/变更：仓库根目录直接执行 `bun install`（根目录 `node_modules` 为真实目录，无需任何隔离区或软链接）。
- 历史上的 `run-linux.sh` 与 `/tmp/reinagent` 隔离区流程**已废弃并删除**（源码盘非网络挂载，可直接编译），严禁再按旧文档执行 rsync 同步或引用隔离区路径。

---

## 4. Key Architectural Rules & Pitfalls (架构避坑与开发铁律)

1. **包管理器限制 (Package Manager Rule)**：
   - 项目采用 **Bun**（`bun@1.4.2` 与 `bun.lock`）。严禁使用 npm/pnpm 更改锁定文件。
   - 依赖安装与变更一律在仓库根目录执行 `bun install`，严禁引入任何外部隔离目录或软链接方案。
2. **Tauri 2 + Web 双模兼容 (Dual-mode Compatibility Rule)**：
   - 涉及系统级能力（终端、文件操作、对话框等）时，必须编写 Web Mock / Browser Fallback 兼容层，保证在 Headless Chrome（无头自动化测试/截图回归）或浏览器环境下依然可完整运行。
3. **Tailwind CSS v4 语义化变量 (Theme Styling Rule)**：
   - 严禁硬编码 Hex/RGB 颜色值；必须使用 `src/styles/global.css` 定义的主题语义变量（如 `var(--bg)`、`var(--sidebar-bg)`、`var(--sidebar-text)`、`var(--border)`），确保与 `data-theme` 换肤机制完美协同。
4. **代码保护与提交纪律 (Commit Discipline)**：
   - 未经用户明确许可或确认，**严禁自行调用 `git commit` 或 `git push`**。
   - 调试产生的截图、日志、测试产物统一存放于 `/tmp/`，严禁提交或污染工作区。
5. **拒绝臆测兜底与真实提示铁律 (No Fallback & Fail-Fast Rule)**：
   - 严禁在代码中写死猜测性的模型上下文大小、Token 上限或是否支持多模态（严禁依据模型名做静态硬编码猜测或保留历史旧预设）；
   - 必须 100% 完整解析服务端 API 返回的真实元数据（包括 `context_window`、`max_output_tokens`、`input_modalities` 等）；
   - 若上游接口未返回某个指标，严禁捏造假数据伪装，UI 必须明确展示为未提供/未知，并提示用户；
   - 网络异常、鉴权失败、解析错误等任何环节出问题时，严禁静默吞掉或使用假数据兜底掩盖，必须将完整真实的错误信息直接向用户提示告警。

---

## 5. Project Context & Real-time Update Rule (核心文档实时同步规范)

项目的系统设计分层、组件职责、状态流转、持久化键名及交互细节，完整记录在：
👉 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)

### ⚠️ 铁律规范（必须严格遵守）：
1. **优先查阅**：接手开发或执行任务前，**必须优先通读 `PROJECT_CONTEXT.md`** 获取最精准的开发上下文与设计规范。
2. **及时同步更新**：**后续完成任何功能迭代、架构调整、新增组件或变更存储键名后，必须第一时间同步更新 `PROJECT_CONTEXT.md`**，确保该文档始终作为全项目的**最新单点真相（Single Source of Truth）**，严禁出现代码更新而文档滞后的情况。
