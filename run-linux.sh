#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="/tmp/reinagent"
TARGET_DIR="$WORK_DIR/target"

echo "=== [1/4] 准备 Linux 本地运行环境 ($WORK_DIR) ==="
mkdir -p "$WORK_DIR" "$TARGET_DIR"

# 同步包描述文件
cp "$PROJECT_DIR/package.json" "$WORK_DIR/package.json"
if [ -f "$PROJECT_DIR/bun.lock" ]; then
    cp "$PROJECT_DIR/bun.lock" "$WORK_DIR/bun.lock"
fi

# 安装 Linux 平台原生依赖（位于 /tmp/reinagent/node_modules，避免 CIFS 软链接限制）
if [ ! -d "$WORK_DIR/node_modules" ]; then
    echo "正在安装 Linux 依赖到 $WORK_DIR..."
    (cd "$WORK_DIR" && bun install)
fi

# 链接工程文件并配置 Vite（启用 preserveSymlinks）
ln -sfn "$PROJECT_DIR/src" "$WORK_DIR/src"
ln -sfn "$PROJECT_DIR/public" "$WORK_DIR/public"
ln -sfn "$PROJECT_DIR/tsconfig.json" "$WORK_DIR/tsconfig.json"
ln -sfn "$PROJECT_DIR/tsconfig.node.json" "$WORK_DIR/tsconfig.node.json"
cp -f "$PROJECT_DIR/index.html" "$WORK_DIR/index.html"

node -e '
const fs = require("fs");
let cfg = fs.readFileSync(process.argv[1], "utf8");
if (!cfg.includes("preserveSymlinks")) {
    cfg = cfg.replace("plugins: [react()],", "plugins: [react()],\n  resolve: { preserveSymlinks: true },");
}
fs.writeFileSync(process.argv[2], cfg);
' "$PROJECT_DIR/vite.config.ts" "$WORK_DIR/vite.config.ts"

echo "=== [2/4] 启动 Vite 前端服务 (http://localhost:1420) ==="
# 启动本地 Vite 前端服务
(cd "$WORK_DIR" && bun "$WORK_DIR/node_modules/vite/bin/vite.js" --port 1420) &
VITE_PID=$!

cleanup() {
    echo "正在退出并清理进程..."
    kill $VITE_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等待 Vite 启动
echo "等待前端服务就绪..."
for i in {1..30}; do
    if curl -s http://localhost:1420 >/dev/null 2>&1; then
        echo "前端服务已就绪！"
        break
    fi
    sleep 0.5
done

echo "=== [3/4] 配置 Rust 编译缓存目录 ($TARGET_DIR) ==="
export CARGO_TARGET_DIR="$TARGET_DIR"
export PATH="$WORK_DIR/node_modules/.bin:$HOME/.cargo/bin:$PATH"

echo "=== [4/4] 启动 Tauri 桌面应用 ==="
cd "$PROJECT_DIR"
cargo tauri dev -c '{"build": {"beforeDevCommand": ""}}'

