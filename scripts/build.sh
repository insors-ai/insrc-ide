#!/usr/bin/env bash
#
# Build the insrc IDE (equivalent to `npm run compile` with enough heap).
#
# The stock `npm run compile` target doesn't set --max-old-space-size, so
# the compile-src pass OOMs on large working trees. This wrapper pins the
# heap to 8 GB and routes through gulp's compile task.
#
# Usage:
#   scripts/build.sh              # IDE compile (VSCode workbench)
#   scripts/build.sh ide          # alias for the default
#   scripts/build.sh watch        # incremental watcher
#   scripts/build.sh clean        # remove out/ and out-build/ then rebuild
#   HEAP_MB=12288 scripts/build.sh # override heap size
#
# Note: the daemon lives in the sibling repo insors-ai/insrc since the
# 2026-07-14 split -- build it there with `cd ../insrc && npm run build`.
# This script only handles the IDE (VSCode fork + insrc contributions).
#
# Each invocation writes a timestamped log to
#   /tmp/insrc/build-YYYYMMDD-HHMMSS-<pid>.log
# so failures can be reviewed even when the console output has scrolled
# away. Override the directory with INSRC_BUILD_LOG_DIR.

set -euo pipefail

if [[ "${OSTYPE:-}" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT"

HEAP_MB="${HEAP_MB:-8192}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${HEAP_MB}"

# Always capture the full build output to a timestamped log under /tmp/insrc
# so post-mortem review is possible even when the console has scrolled away
# or the process exited in a background runner. Live stdout / stderr stay
# intact via tee so interactive feedback is unchanged.
LOG_DIR="${INSRC_BUILD_LOG_DIR:-/tmp/insrc}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/build-$(date +%Y%m%d-%H%M%S)-$$.log"
echo "[insrc-build] logging to $LOG_FILE"
# Redirect both streams through tee; subsequent commands inherit the pipe.
exec > >(tee -a "$LOG_FILE") 2>&1

# Skip dependency install by exporting INSRC_SKIP_INSTALL=1 (useful for CI or
# when you've just run npm install yourself and want faster iteration).
SKIP_INSTALL="${INSRC_SKIP_INSTALL:-0}"

install_if_needed() {
	local dir="$1"
	local label="$2"
	local extra_flags="${3:-}"
	if [ "$SKIP_INSTALL" = "1" ]; then
		return
	fi
	echo "[insrc-build] installing $label deps"
	# shellcheck disable=SC2086
	( cd "$dir" && npm install --no-audit --no-fund $extra_flags )
}

build_ide() {
	install_if_needed "." "IDE"
	echo "[insrc-build] IDE compile (heap=${HEAP_MB}MB)"
	npm run compile
}

cmd="${1:-ide}"
shift || true

case "$cmd" in
	all|""|compile|ide)
		build_ide
		;;
	daemon)
		echo "[insrc-build] daemon lives in the sibling repo insors-ai/insrc since the 2026-07-14 split." >&2
		echo "[insrc-build]   cd ../insrc && npm run build" >&2
		exit 2
		;;
	watch)
		echo "[insrc-build] IDE watch (heap=${HEAP_MB}MB)"
		exec npm run watch "$@"
		;;
	clean)
		echo "[insrc-build] clean"
		rm -rf out out-build
		build_ide
		;;
	*)
		echo "Unknown command: $cmd" >&2
		echo "Usage: $0 [ide|watch|clean]  (daemon lives in ../insrc now)" >&2
		exit 2
		;;
esac
