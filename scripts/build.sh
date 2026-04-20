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
#   scripts/build.sh daemon       # daemon only (src/insrc → out/insrc)
#   scripts/build.sh watch        # incremental watcher (IDE only)
#   scripts/build.sh clean        # remove out/ and out-build/ then full build
#   HEAP_MB=12288 scripts/build.sh # override heap size

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

build_ide() {
	echo "[insrc-build] IDE compile (heap=${HEAP_MB}MB)"
	npm run compile
}

build_daemon() {
	echo "[insrc-build] daemon compile (tsc → out/insrc)"
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
