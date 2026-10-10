#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="tju-mas-parser:local"
BASE="python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c"
DOCKER="$(command -v docker || true)"
if [[ -z "$DOCKER" && -x "$HOME/.docker/bin/docker" ]]; then DOCKER="$HOME/.docker/bin/docker"; fi
if [[ -z "$DOCKER" ]]; then echo "Docker Desktop is required" >&2; exit 2; fi
SAFE=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges
      --pids-limit 64 --memory 2g --cpus 2 --user "$(id -u):$(id -g)"
      --tmpfs /tmp:rw,nosuid,nodev,size=256m)
case "${1:-}" in
  build)
    umask 077
    WHEELS="$ROOT/.local-data/parser/wheels"
    mkdir -p "$WHEELS"
    # Download wheel archives only. No user PDF, credentials or Pi state is mounted.
    "$DOCKER" run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 64 --memory 1g --user "$(id -u):$(id -g)" \
      -v "$ROOT/services/parser:/requirements:ro" -v "$WHEELS:/wheels" "$BASE" \
      python -m pip download --disable-pip-version-check --no-cache-dir --only-binary=:all: \
      --index-url https://pypi.org/simple --require-hashes --dest /wheels \
      -r /requirements/requirements.lock -r /requirements/requirements-test.lock
    "$DOCKER" build --network none --build-context "wheels=$WHEELS" --target runtime \
      -f "$ROOT/deploy/Dockerfile.parser" -t "$IMAGE" "$ROOT"
    "$DOCKER" build --network none --build-context "wheels=$WHEELS" --target test \
      -f "$ROOT/deploy/Dockerfile.parser" -t "$IMAGE-test" "$ROOT"
    ;;
  test)
    "$DOCKER" run "${SAFE[@]}" "$IMAGE-test" timeout 120 python -m unittest discover -s tests -v
    ;;
  parse)
    [[ $# -eq 3 && -f "$2" && ! -e "$3" ]] || { echo 'Usage: parser-container.sh parse INPUT.pdf NEW_OUTPUT_DIRECTORY' >&2; exit 2; }
    INPUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    OUTPUT_PARENT="$(cd "$(dirname "$3")" && pwd)"
    OUTPUT_NAME="$(basename "$3")"
    [[ "$OUTPUT_NAME" != . && "$OUTPUT_NAME" != .. ]] || exit 2
    umask 077
    OUTPUT_DIR="$OUTPUT_PARENT/$OUTPUT_NAME"
    mkdir -m 700 "$OUTPUT_DIR"
    "$DOCKER" run "${SAFE[@]}" -v "$INPUT:/input/$(basename "$INPUT"):ro" \
      -v "$OUTPUT_DIR:/output" "$IMAGE" timeout 180 python -m src.pipeline \
      "/input/$(basename "$INPUT")" /output/result
    ;;
  *) echo 'Usage: parser-container.sh {build|test|parse INPUT.pdf NEW_OUTPUT_DIRECTORY}' >&2; exit 2 ;;
esac
