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

build_daemon() {
	install_if_needed "src/insrc" "daemon" "--legacy-peer-deps"
	echo "[insrc-build] daemon compile (tsc -> out/insrc)"
	( cd src/insrc && npm run build )
	# tsc only emits .ts -> .js; non-code assets (HTML templates, JSON
	# metadata, etc.) need to be mirrored into out/insrc so the daemon
	# can read them at runtime via paths relative to import.meta.url.
	if [ -d "src/insrc/assets" ]; then
		echo "[insrc-build] copying daemon assets"
		mkdir -p out/insrc/assets
		# -a preserves timestamps so incremental builds stay cheap.
		cp -a src/insrc/assets/. out/insrc/assets/
	fi
	# Mirror all *.md prompt files from src/insrc to out/insrc preserving
	# the directory layout. Daemon prompts (e.g. agent/tasks/code-analyzer/
	# prompts/**/*.md) are loaded at runtime via paths relative to
	# import.meta.url, so they must live next to the compiled .js. Generic
	# glob -- no per-directory edit when new prompts are added. Excludes
	# node_modules/ (third-party READMEs) and __tests__/ (test fixtures).
	# Prompt MDs are mirrored to out/ by `npm run build` (which now
	# chains `tsc` + `node scripts/copy-prompts.mjs`). The build above
	# already invoked `npm run build`, so out/insrc/.../prompts/ is
	# populated. No extra step needed here.
}

cmd="${1:-all}"
shift || true

case "$cmd" in
	all|""|compile)
		install_if_needed "src/insrc" "daemon" "--legacy-peer-deps"
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
		install_if_needed "src/insrc" "daemon" "--legacy-peer-deps"
		build_ide
		build_daemon
		;;
	*)
		echo "Unknown command: $cmd" >&2
		echo "Usage: $0 [all|ide|daemon|watch|clean]" >&2
		exit 2
		;;
esac
