#!/usr/bin/env bash
# 从权威 Schema 生成语言类型。
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/generate-types.mjs" "$@"