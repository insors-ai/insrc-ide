#!/usr/bin/env bash
#
# Build the insrc IDE (equivalent to `npm run compile` with enough heap).
#
# The stock `npm run compile` target doesn't set --max-old-space-size, so
# the compile-src pass OOMs on large working trees. This wrapper pins the
# heap to 8 GB and routes through gulp's compile task.
#
# Usage:
#   scripts/build.sh              # IDE + daemon (default)
#   scripts/build.sh ide          # IDE only (VSCode workbench)
#   scripts/build.sh daemon       # daemon only (src/insrc -> out/insrc)
#   scripts/build.sh watch        # incremental watcher (IDE only)
#   scripts/build.sh clean        # remove out/ and out-build/ then full build
#   HEAP_MB=12288 scripts/build.sh # override heap size
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
	if [ "$SKIP_INSTALL" = "1" ]; then
		return
	fi
	# Run npm install when node_modules is missing, or when the lockfile /
	# package.json is newer than the install marker. Cheap check; no-op on
	# warm builds so iteration stays fast.
	if [ ! -d "$dir/node_modules" ] \
		|| [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ] 2>/dev/null \
		|| [ "$dir/package.json" -nt "$dir/node_modules/.package-lock.json" ] 2>/dev/null; then
		echo "[insrc-build] installing $label deps"
		( cd "$dir" && npm install --no-audit --no-fund )
	fi
}

build_ide() {
	install_if_needed "." "IDE"
	echo "[insrc-build] IDE compile (heap=${HEAP_MB}MB)"
	npm run compile
}

build_daemon() {
	install_if_needed "src/insrc" "daemon"
	echo "[insrc-build] daemon compile (tsc -> out/insrc)"
	( cd src/insrc && npm run build )
}

cmd="${1:-all}"
shift || true

case "$cmd" in
	all|""|compile)
		build_ide
		build_daemon
		;;
	ide)
		build_ide
		;;
	daemon)
		build_daemon
		;;
	watch)
		echo "[insrc-build] IDE watch (heap=${HEAP_MB}MB) -- run 'scripts/build.sh daemon' separately after daemon-side edits"
		exec npm run watch "$@"
		;;
	clean)
		echo "[insrc-build] clean"
		rm -rf out out-build
		build_ide
		build_daemon
		;;
	*)
		echo "Unknown command: $cmd" >&2
		echo "Usage: $0 [all|ide|daemon|watch|clean]" >&2
		exit 2
		;;
esac
