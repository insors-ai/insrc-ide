#!/usr/bin/env bash
#
# Control script for the insrc daemon installed at ~/.insrc/daemon.
#
# The daemon lives in a git checkout of insrc-ide at ~/.insrc/daemon.
# Between edits: push commits to origin from your working tree, then
# run `daemon-ctl.sh restart` from either checkout -- this script
# targets ~/.insrc/daemon regardless of where you invoke it from.
#
# Usage:
#   scripts/daemon-ctl.sh start      # sync origin, install if lock changed, build, start
#   scripts/daemon-ctl.sh stop       # graceful stop (5 s timeout)
#   scripts/daemon-ctl.sh restart    # stop then start
#   scripts/daemon-ctl.sh update     # sync + install + build (no start)
#   scripts/daemon-ctl.sh status     # daemon status
#   scripts/daemon-ctl.sh --help
#
# Flags:
#   --skip-sync       skip the git fetch / merge step
#   --skip-install    skip npm install even if the lock changed
#   --skip-build      skip the tsc build step
#   --branch <name>   sync against a branch other than the current one
#
# Exit codes:
#   0 success
#   1 usage error
#   2 daemon dir missing / not a git checkout
#   3 git in an unclean state (uncommitted work / diverged)
#   4 install / build / start failed
#
# Log path: /tmp/insrc/daemon-ctl-YYYYMMDD-HHMMSS-<pid>.log

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DAEMON_ROOT="${INSRC_DAEMON_ROOT:-$HOME/.insrc/daemon}"
DAEMON_SRC="$DAEMON_ROOT/src/insrc"
LOG_DIR="${INSRC_CTL_LOG_DIR:-/tmp/insrc}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daemon-ctl-$(date +%Y%m%d-%H%M%S)-$$.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }
die() { log "ERROR: $*"; exit "${2:-1}"; }

require_daemon_dir() {
	[ -d "$DAEMON_ROOT/.git"  ] || die "not a git checkout: $DAEMON_ROOT" 2
	[ -d "$DAEMON_SRC"        ] || die "missing src tree: $DAEMON_SRC" 2
}

usage() {
	sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

sync_repo() {
	local branch="$1"
	log "syncing $DAEMON_ROOT against origin/$branch"
	git -C "$DAEMON_ROOT" fetch --quiet origin "$branch"

	# Refuse to run when there are local changes -- the daemon install
	# is meant to mirror origin exactly.
	if ! git -C "$DAEMON_ROOT" diff --quiet || ! git -C "$DAEMON_ROOT" diff --cached --quiet; then
		die "$DAEMON_ROOT has uncommitted local changes; refusing to overwrite" 3
	fi

	local current
	current=$(git -C "$DAEMON_ROOT" rev-parse HEAD)
	local incoming
	incoming=$(git -C "$DAEMON_ROOT" rev-parse "origin/$branch")

	if [ "$current" = "$incoming" ]; then
		log "already at $incoming (no-op)"
		return 0
	fi

	# Fast-forward only. If HEAD isn't an ancestor of origin the
	# working tree has diverged -- abort so a human resolves it.
	if ! git -C "$DAEMON_ROOT" merge-base --is-ancestor "$current" "$incoming"; then
		die "$DAEMON_ROOT/HEAD has diverged from origin/$branch; resolve manually" 3
	fi

	log "fast-forward: ${current:0:8} -> ${incoming:0:8}"
	git -C "$DAEMON_ROOT" merge --ff-only "$incoming" >>"$LOG_FILE" 2>&1
}

npm_install_if_needed() {
	local lock_before="${SYNC_LOCK_HASH_BEFORE:-}"
	local lock_after
	lock_after=$(git -C "$DAEMON_ROOT" hash-object src/insrc/package-lock.json 2>/dev/null || echo "")

	# Force install on first run or when the lock changed via the pull.
	if [ -z "$lock_before" ] || [ "$lock_before" != "$lock_after" ] || [ ! -d "$DAEMON_SRC/node_modules" ]; then
		log "npm install ($DAEMON_SRC)"
		( cd "$DAEMON_SRC" && npm install ) >>"$LOG_FILE" 2>&1 || die "npm install failed (see $LOG_FILE)" 4
	else
		log "npm install: package-lock.json unchanged; skipping"
	fi
}

npm_build() {
	log "npm run build ($DAEMON_SRC)"
	( cd "$DAEMON_SRC" && npm run build ) >>"$LOG_FILE" 2>&1 || die "npm run build failed (see $LOG_FILE)" 4
}

daemon_cli() {
	# `insrc` is not on PATH in most setups; drive the CLI via tsx from
	# the same source tree we just built.
	( cd "$DAEMON_SRC" && npx --no-install tsx cli/index.ts "$@" )
}

# Poll for the daemon pid file to disappear, meaning the daemon has
# fully drained + exited. The daemon's internal shutdown backstop
# fires at 20 s; give ourselves 30 s wall clock to cover it plus a
# little slack. Returns 0 when the daemon is gone, 1 on timeout.
wait_for_daemon_stop() {
	local pid_file="$HOME/.insrc/daemon.pid"
	local sock_file="$HOME/.insrc/daemon.sock"
	local deadline=$(( $(date +%s) + 30 ))

	while [ "$(date +%s)" -lt "$deadline" ]; do
		# Gone when both the pid file AND the socket are cleaned up.
		# The socket lingers briefly after the daemon exits.
		if [ ! -f "$pid_file" ] && [ ! -S "$sock_file" ]; then
			return 0
		fi
		# If the pid file references a pid that's no longer running,
		# it's stale -- remove it so `daemon start` doesn't refuse.
		if [ -f "$pid_file" ]; then
			local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
			if [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; then
				rm -f "$pid_file"
			fi
		fi
		sleep 0.5
	done
	return 1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_start() {
	require_daemon_dir
	local branch="${BRANCH:-$(git -C "$DAEMON_ROOT" rev-parse --abbrev-ref HEAD)}"
	local lock_before
	lock_before=$(git -C "$DAEMON_ROOT" hash-object src/insrc/package-lock.json 2>/dev/null || echo "")
	SYNC_LOCK_HASH_BEFORE="$lock_before"

	[ "$SKIP_SYNC"    -eq 1 ] || sync_repo "$branch"
	[ "$SKIP_INSTALL" -eq 1 ] || npm_install_if_needed
	[ "$SKIP_BUILD"   -eq 1 ] || npm_build

	# Stop any stale daemon first + wait for full drain so `daemon
	# start` doesn't race the shutdown backstop (~20 s).
	local pid_file="$HOME/.insrc/daemon.pid"
	if [ -f "$pid_file" ] && ps -p "$(cat "$pid_file")" >/dev/null 2>&1; then
		log "stopping stale daemon (pid $(cat "$pid_file"))"
		daemon_cli daemon stop >>"$LOG_FILE" 2>&1 || true
		wait_for_daemon_stop || die "stale daemon did not shut down within 30 s (see /tmp/.insrc/daemon.log)" 4
		log "stale daemon shut down"
	fi

	log "starting daemon"
	daemon_cli daemon start >>"$LOG_FILE" 2>&1 || die "daemon start failed (see $LOG_FILE)" 4
	sleep 1
	local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "?")
	if [ "$pid" = "?" ] || ! ps -p "$pid" >/dev/null 2>&1; then
		die "daemon reported started but pid $pid is not running (see /tmp/.insrc/daemon.log)" 4
	fi
	log "daemon running (pid $pid, log /tmp/.insrc/daemon.log)"
	log "ctl-log: $LOG_FILE"
}

cmd_stop() {
	require_daemon_dir
	log "stopping daemon"
	daemon_cli daemon stop 2>&1 | tee -a "$LOG_FILE" | tail -3
	if wait_for_daemon_stop; then
		log "daemon shut down"
	else
		die "daemon did not shut down within 30 s (see /tmp/.insrc/daemon.log)" 4
	fi
}

cmd_restart() {
	# cmd_stop already waits for full drain, so start won't race the
	# shutdown backstop.
	cmd_stop || true
	cmd_start
}

cmd_update() {
	require_daemon_dir
	local branch="${BRANCH:-$(git -C "$DAEMON_ROOT" rev-parse --abbrev-ref HEAD)}"
	local lock_before
	lock_before=$(git -C "$DAEMON_ROOT" hash-object src/insrc/package-lock.json 2>/dev/null || echo "")
	SYNC_LOCK_HASH_BEFORE="$lock_before"

	[ "$SKIP_SYNC"    -eq 1 ] || sync_repo "$branch"
	[ "$SKIP_INSTALL" -eq 1 ] || npm_install_if_needed
	[ "$SKIP_BUILD"   -eq 1 ] || npm_build
	log "update complete (daemon NOT restarted)"
}

cmd_status() {
	require_daemon_dir
	local branch
	branch=$(git -C "$DAEMON_ROOT" rev-parse --abbrev-ref HEAD)
	local head
	head=$(git -C "$DAEMON_ROOT" log --oneline -1)
	log "daemon dir: $DAEMON_ROOT"
	log "branch:     $branch"
	log "HEAD:       $head"
	daemon_cli daemon status 2>&1 | tee -a "$LOG_FILE" | tail -20
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

SKIP_SYNC=0
SKIP_INSTALL=0
SKIP_BUILD=0
BRANCH=""
CMD=""

while [ $# -gt 0 ]; do
	case "$1" in
		start|stop|restart|update|status) CMD="$1" ;;
		--skip-sync)    SKIP_SYNC=1 ;;
		--skip-install) SKIP_INSTALL=1 ;;
		--skip-build)   SKIP_BUILD=1 ;;
		--branch)       shift; BRANCH="${1:-}"; [ -n "$BRANCH" ] || die "--branch requires a value" ;;
		-h|--help)      usage ;;
		*)              die "unknown arg: $1 (see --help)" ;;
	esac
	shift
done

[ -n "$CMD" ] || usage

case "$CMD" in
	start)   cmd_start ;;
	stop)    cmd_stop ;;
	restart) cmd_restart ;;
	update)  cmd_update ;;
	status)  cmd_status ;;
esac
