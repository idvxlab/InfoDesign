#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
local_config="$project_root/.local-data/dev-container"
if command -v docker >/dev/null 2>&1; then
  docker_bin="$(command -v docker)"
elif [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
  docker_bin=/Applications/Docker.app/Contents/Resources/bin/docker
else
  echo '请先安装并启动 Docker Desktop。' >&2
  exit 1
fi
export PATH="$(dirname "$docker_bin"):$PATH"

compose() {
  "$docker_bin" compose --env-file /dev/null --project-name tju-mas-dev \
    --file "$project_root/deploy/compose.dev.yml" "$@"
}

init_config() {
  mkdir -p "$local_config"
  # 不覆盖已有配置，不读取或打印用户密钥。
  if [[ ! -e "$local_config/models.json" ]]; then
    printf '%s\n' '{"providers":{}}' > "$local_config/models.json"
  fi
  if [[ ! -e "$local_config/allowed-hosts.txt" ]]; then
    printf '%s\n' '# 每行填写一个确切的 API 域名，不含 https://、路径或端口。' 'disabled.invalid' > "$local_config/allowed-hosts.txt"
  fi
  if [[ ! -e "$local_config/pi.env" ]]; then
    (umask 077; printf '%s\n' 'APP_MODEL_API_KEY=' > "$local_config/pi.env")
  fi
}

case "${1:-help}" in
  init)
    init_config
    echo "本地配置目录：$local_config"
    ;;
  build)
    init_config
    compose build
    ;;
  up)
    init_config
    compose up -d --force-recreate
    ;;
  shell)
    compose exec dev bash
    ;;
  pi)
    compose exec dev pi
    ;;
  exec)
    shift
    compose exec -T dev "$@"
    ;;
  check)
    container_id="$(compose ps -q dev)"
    [[ -n "$container_id" ]] || { echo '请先启动开发容器。' >&2; exit 1; }
    # 不输出 inspect 的环境变量，避免泄露用户后来填写的 key。
    compose exec -T dev sh -c 'cat > /tmp/check-dev-container.mjs' < "$project_root/scripts/check-dev-container.mjs"
    "$docker_bin" inspect --format '{"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}' "$container_id" \
      | compose exec -T -e "HOST_PROJECT_ROOT=$project_root" dev node /tmp/check-dev-container.mjs
    ;;
  check-network)
    # 使用独立的临时代理验证允许路径，不修改用户的域名白名单或模型配置。
    test_dir="$(mktemp -d "$local_config/network-check.XXXXXX")"
    printf '%s\n' registry.npmjs.org > "$test_dir/allowed-hosts.txt"
    test_proxy="tju-mas-egress-check-$$"
    compose run --rm -d --no-deps --name "$test_proxy" \
      -v "$test_dir/allowed-hosts.txt:/etc/squid/allowed-hosts.txt:ro" egress >/dev/null
    trap '"$docker_bin" stop "$test_proxy" >/dev/null' EXIT
    compose exec -T \
      -e "HTTP_PROXY=http://$test_proxy:3128" -e "HTTPS_PROXY=http://$test_proxy:3128" \
      -e "http_proxy=http://$test_proxy:3128" -e "https_proxy=http://$test_proxy:3128" \
      dev node --input-type=module -e '
        import assert from "node:assert/strict";
        const response = await fetch("https://registry.npmjs.org/-/ping", { signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200);
        await response.body.cancel();
        console.log("PASS: 独立测试代理放行指定 HTTPS 域名；未使用模型凭据，未修改用户白名单。");
      '
    ;;
  export)
    mkdir -p "$local_config/exports"
    export_dir="$(mktemp -d "$local_config/exports/export.XXXXXX")"
    compose exec -T dev node /workspace/scripts/export-dev-source.mjs > "$export_dir/source.tar.gz"
    echo "已创建可选源码归档：$export_dir/source.tar.gz（源码已与 Mac 直接共享，无需导出同步）"
    ;;
  stop)
    compose stop
    ;;
  status)
    compose ps
    ;;
  *)
    echo '用法：bash scripts/dev-container.sh {init|build|up|shell|pi|exec|check|check-network|export|stop|status}'
    ;;
esac
