#!/bin/sh
set -eu

# 源码直接挂载宿主项目；只在 Linux 依赖卷中安装，不再复制源码或创建 Git 仓库。
cd /workspace
if ! CI=true pnpm install --offline --frozen-lockfile --store-dir /opt/pnpm-store; then
    echo '容器依赖初始化失败。若更新了依赖，请先在 Mac 执行 bash scripts/dev-container.sh build，再执行 up。' >&2
    exit 1
fi
exec "$@"
