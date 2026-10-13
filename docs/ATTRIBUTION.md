# 站点署名与第三方许可 (Attribution)

本官网（`docs/` 目录下的静态站点）的页面骨架、`assets/site.css`、`assets/site.js` 与截图灯箱、
主题切换、代码复制等交互实现，改编自 **Hetu（河图）官方站点**：

- 项目：Hetu — 本地优先的 AI 知识与 Agent 工作台
- 源码：<https://github.com/wosledon/Hetu>（站点位于该仓库 `docs/` 目录）
- 许可：Apache License 2.0
- 版权：© 2026 Hetu Contributors

## 改编范围

| 文件 | 处理方式 |
| --- | --- |
| `assets/site.css` | 复用设计系统（语义化 CSS 变量、明暗主题、卡片/文档/代码块等组件样式），仅修改表头注释 |
| `assets/site.js` | 复用交互逻辑（主题切换、移动端导航、代码复制、截图灯箱、访问计数、版本号拉取），替换品牌键名与仓库指向 |
| 页面骨架 | 复用 header / hero / section / docs 侧栏 / footer / lightbox 结构，正文与文案全部重写为 ReinAgent 内容 |
| `assets/favicon.svg` | 替换为 ReinAgent 标识 |

## 许可声明

依据 Apache License 2.0 第 4 条，特此说明：

- 本目录中的上述改编文件保留原始版权声明与许可声明；
- Apache License 2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>；
- 本仓库其余代码以仓库根目录 [LICENSE](../LICENSE)（MIT）授权，两者互不影响。

站点正文内容、产品文案与 ReinAgent 相关的全部文字描述为本项目原创。
