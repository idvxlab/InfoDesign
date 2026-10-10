#!/usr/bin/env bash
# 验证已实现的协议与测试实例：Schema 引用完整性、结构层正反例、生成类型一致性。
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$script_dir/generate-types.mjs" --check
node "$script_dir/check-contracts.mjs"