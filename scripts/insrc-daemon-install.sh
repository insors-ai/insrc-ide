#!/usr/bin/env bash
#
# insrc daemon bootstrap installer.
#
# What this script does:
#   1. Verify prerequisites (Node.js >= 20, git).
#   2. Clone insors-ai/insrc-ide.git into ~/.insrc/daemon (configurable).
#   3. Fast-forward the checkout to the configured branch head.
#   4. npm install + npm run build in src/insrc.
#   5. Symlink out/insrc/node_modules -> ../../src/insrc/node_modules so the
#      compiled MCP binary resolves its deps.
#   6. Start the daemon (unless --no-start).
#   7. Print next-step guidance (MCP registration, docs pointer).
#
# The script is INTENTIONALLY the entire distribution -- there is no
# code payload. The actual daemon source is pulled from GitHub at
# install time. Update the install by re-running this script or by
# running $INSTALL_ROOT/scripts/daemon-ctl.sh update.
#
# Usage:
#   ./insrc-daemon-install.sh                       # install to ~/.insrc/daemon on default branch
#   ./insrc-daemon-install.sh --target /custom/path # override install location
#   ./insrc-daemon-install.sh --branch main         # track a different branch
#   ./insrc-daemon-install.sh --no-start            # install + build but don't start
#   ./insrc-daemon-install.sh --repo <url>          # install from a fork
#   ./insrc-daemon-install.sh -y                    # non-interactive, assume defaults
#   ./insrc-daemon-install.sh --help
#
# One-liner:
#   curl -fsSL https://github.com/insors-ai/insrc-ide/releases/download/daemon-v0.1.0/insrc-daemon-install.sh | bash
#
# Exit codes:
#   0 success
#   1 usage error / user abort
#   2 prerequisites missing (node / git / node version too old)
#   3 install target not usable (exists but not a git checkout, or unwritable)
#   4 git / npm / build step failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults + argv
# ---------------------------------------------------------------------------

DEFAULT_REPO_URL='https://github.com/insors-ai/insrc-ide.git'
DEFAULT_BRANCH='release/1.96'
DEFAULT_TARGET="$HOME/.insrc/daemon"
NODE_MIN_MAJOR=20

INSTALL_ROOT="$DEFAULT_TARGET"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="$DEFAULT_BRANCH"
START_AFTER_INSTALL=1
ASSUME_YES=0
LOG_FILE=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Colour helpers (skipped when stdout isn't a tty)
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
	C_CYAN=$(tput setaf 6); C_GREEN=$(tput setaf 2)
	C_YELLOW=$(tput setaf 3); C_RED=$(tput setaf 1)
	C_BOLD=$(tput bold); C_RESET=$(tput sgr0)
else
	C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RESET=""
fi

log()  { printf '%s[%s]%s %s\n' "$C_CYAN" "$(date +%H:%M:%S)" "$C_RESET" "$*"; [ -n "$LOG_FILE" ] && echo "[$(date +%H:%M:%S)] $*" >>"$LOG_FILE" || true; }
ok()   { printf '%s[OK]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; [ -n "$LOG_FILE" ] && echo "OK: $*" >>"$LOG_FILE" || true; }
warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; [ -n "$LOG_FILE" ] && echo "WARN: $*" >>"$LOG_FILE" || true; }
die()  { printf '%s[FATAL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; [ -n "$LOG_FILE" ] && echo "FATAL: $*" >>"$LOG_FILE" || true; exit "${2:-1}"; }

usage() {
	sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
}

confirm() {
	# confirm "prompt text"  -> returns 0 on yes, 1 on no.
	# Skips if --yes is set.
	if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
	local prompt="$1"
	printf '%s? %s [Y/n] ' "$C_BOLD" "$prompt$C_RESET"
	read -r reply || return 1
	case "$reply" in
		''|y|Y|yes|Yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

# ---------------------------------------------------------------------------
# Argv parsing
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
	case "$1" in
		--target)    shift; INSTALL_ROOT="${1:-}"; [ -n "$INSTALL_ROOT" ] || die "--target requires a value" ;;
		--branch)    shift; BRANCH="${1:-}";       [ -n "$BRANCH" ]       || die "--branch requires a value" ;;
		--repo)      shift; REPO_URL="${1:-}";     [ -n "$REPO_URL" ]     || die "--repo requires a value" ;;
		--no-start)  START_AFTER_INSTALL=0 ;;
		-y|--yes)    ASSUME_YES=1 ;;
		-h|--help)   usage ;;
		*)           die "unknown arg: $1 (see --help)" ;;
	esac
	shift
done

DAEMON_SRC="$INSTALL_ROOT/src/insrc"
LOG_DIR="/tmp/insrc"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"
LOG_FILE="$LOG_DIR/daemon-install-$(date +%Y%m%d-%H%M%S)-$$.log"
touch "$LOG_FILE" 2>/dev/null || LOG_FILE=""

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

printf '\n%s%s=== insrc daemon installer ===%s\n\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
log "target:    $INSTALL_ROOT"
log "repo URL:  $REPO_URL"
log "branch:    $BRANCH"
log "auto-start: $([ "$START_AFTER_INSTALL" -eq 1 ] && echo yes || echo no)"
[ -n "$LOG_FILE" ] && log "install log: $LOG_FILE"
printf '\n'

# ---------------------------------------------------------------------------
# Step 1: prerequisites
# ---------------------------------------------------------------------------

log "checking prerequisites..."

command -v git >/dev/null 2>&1 || die "git not found on PATH" 2

if ! command -v node >/dev/null 2>&1; then
	die "node not found on PATH -- install Node.js >= $NODE_MIN_MAJOR first (https://nodejs.org/)" 2
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
	die "node $NODE_MAJOR is too old -- need Node.js >= $NODE_MIN_MAJOR" 2
fi
ok "node $(node -v) + git $(git --version | awk '{print $3}')"

if ! command -v npm >/dev/null 2>&1; then
	die "npm not found on PATH (comes with Node.js)" 2
fi

# ---------------------------------------------------------------------------
# Step 2: clone or update the checkout
# ---------------------------------------------------------------------------

if [ -e "$INSTALL_ROOT" ]; then
	if [ ! -d "$INSTALL_ROOT/.git" ]; then
		die "$INSTALL_ROOT exists but is not a git checkout -- move it aside or use --target <other>" 3
	fi
	log "existing checkout found at $INSTALL_ROOT"
	confirm "update it (fast-forward to origin/$BRANCH)" || die "user declined" 1
	log "fetching origin..."
	git -C "$INSTALL_ROOT" fetch --quiet origin "$BRANCH"
	# Fast-forward only.
	CURRENT=$(git -C "$INSTALL_ROOT" rev-parse HEAD)
	INCOMING=$(git -C "$INSTALL_ROOT" rev-parse "origin/$BRANCH")
	if [ "$CURRENT" != "$INCOMING" ]; then
		if ! git -C "$INSTALL_ROOT" merge-base --is-ancestor "$CURRENT" "$INCOMING"; then
			die "$INSTALL_ROOT/HEAD has diverged from origin/$BRANCH -- resolve manually or move the tree aside" 3
		fi
		git -C "$INSTALL_ROOT" checkout --quiet "$BRANCH" 2>/dev/null || true
		git -C "$INSTALL_ROOT" merge --quiet --ff-only "$INCOMING"
		ok "fast-forwarded ${CURRENT:0:8} -> ${INCOMING:0:8}"
	else
		ok "already at ${CURRENT:0:8} (no-op)"
	fi
else
	log "cloning $REPO_URL into $INSTALL_ROOT (branch: $BRANCH) ..."
	mkdir -p "$(dirname "$INSTALL_ROOT")"
	git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_ROOT"
	ok "clone complete"
fi

# ---------------------------------------------------------------------------
# Step 3: npm install + build
# ---------------------------------------------------------------------------

[ -d "$DAEMON_SRC" ] || die "expected daemon source at $DAEMON_SRC but not found -- was the branch renamed?" 3

log "installing daemon dependencies (may take a few minutes on first install) ..."
( cd "$DAEMON_SRC" && npm install --no-fund --no-audit ) 2>&1 | tail -3 | while IFS= read -r line; do
	printf '   %s\n' "$line"
done
ok "npm install done"

log "building daemon (tsc) ..."
( cd "$DAEMON_SRC" && npm run --silent build ) 2>&1 | tail -5 | while IFS= read -r line; do
	printf '   %s\n' "$line"
done
ok "build done"

# ---------------------------------------------------------------------------
# Step 4: symlink out/insrc/node_modules -> ../../src/insrc/node_modules
# ---------------------------------------------------------------------------

# The compiled binary at out/insrc/bin/insrc-mcp.js needs node_modules
# resolvable from out/insrc/. tsc doesn't copy them, and creating a symlink
# is the least-fragile fix. See memory: [[out-insrc-node-modules-symlink]].
OUT_DIR="$INSTALL_ROOT/out/insrc"
if [ -d "$OUT_DIR" ] && [ ! -e "$OUT_DIR/node_modules" ]; then
	ln -sf ../../src/insrc/node_modules "$OUT_DIR/node_modules"
	ok "symlinked out/insrc/node_modules -> src/insrc/node_modules"
fi

# ---------------------------------------------------------------------------
# Step 4b: Ollama probe + first-boot config
# ---------------------------------------------------------------------------

# On a fresh install with NO Ollama, the daemon would boot with its
# default config (embeddingModel=qwen3-embedding:0.6b, embeddingDim=
# 1024), probe Ollama, fail, fall back to ONNX (nomic-embed-text-v1.5,
# 768-dim), notice the config-dim vs ONNX-dim mismatch, and disable
# vector ops. Bad UX for a first-time install.
#
# Fix: probe Ollama here. If it isn't reachable AND the user has no
# existing config.json, write a config that pre-sets the ONNX-matching
# dim so first boot activates ONNX cleanly. If the user has an
# existing config (returning install), leave it alone -- they've
# chosen deliberately.

CONFIG_FILE="$HOME/.insrc/config.json"
HAS_OLLAMA=0
OLLAMA_HOST_URL="${OLLAMA_HOST:-http://localhost:11434}"
if curl -fsS --max-time 2 "$OLLAMA_HOST_URL/api/tags" >/dev/null 2>&1; then
	HAS_OLLAMA=1
	ok "detected Ollama at $OLLAMA_HOST_URL"
else
	log "Ollama not detected at $OLLAMA_HOST_URL -- daemon will use the in-process ONNX embedder (nomic-embed-text-v1.5, ~140 MB downloaded on first use)"
	# Only auto-write config if the user has none. Don't overwrite an
	# existing config: they may have deliberately configured it.
	if [ ! -f "$CONFIG_FILE" ]; then
		mkdir -p "$HOME/.insrc"
		cat > "$CONFIG_FILE" <<'CFG'
{
	"models": {
		"providers": {
			"local": {
				"host":           "http://localhost:11434",
				"embeddingModel": "nomic-ai/nomic-embed-text-v1.5",
				"embeddingDim":   768,
				"coreModel":      "qwen3-coder:latest",
				"charsPerToken":  3
			}
		},
		"analyze": {
			"shaperProvider": "cli-claude",
			"shaperModel":    "qwen3.6:35b-a3b"
		}
	}
}
CFG
		ok "wrote $CONFIG_FILE (ONNX embedder + shaperProvider=cli-claude)"
	else
		log "existing $CONFIG_FILE left in place"
	fi
fi

# ---------------------------------------------------------------------------
# Step 5: start
# ---------------------------------------------------------------------------

CTL="$INSTALL_ROOT/scripts/daemon-ctl.sh"
if [ ! -x "$CTL" ] && [ -f "$CTL" ]; then chmod +x "$CTL" 2>/dev/null || true; fi

if [ "$START_AFTER_INSTALL" -eq 1 ] && [ -x "$CTL" ]; then
	log "starting daemon ..."
	INSRC_DAEMON_ROOT="$INSTALL_ROOT" "$CTL" start --skip-sync --skip-install --skip-build 2>&1 | tail -3 | while IFS= read -r line; do
		printf '   %s\n' "$line"
	done
	ok "daemon started"
else
	if [ "$START_AFTER_INSTALL" -eq 0 ]; then
		log "skipping daemon start (--no-start)"
	else
		warn "daemon-ctl.sh not found at $CTL -- skipping start step"
	fi
fi

# ---------------------------------------------------------------------------
# Step 6: next-step guidance
# ---------------------------------------------------------------------------

printf '\n%s%sinsrc daemon install complete.%s\n\n' "$C_BOLD" "$C_GREEN" "$C_RESET"

if [ "$HAS_OLLAMA" -eq 0 ]; then
	cat <<EOF
Embedder: in-process ONNX (nomic-embed-text-v1.5, 768-dim). The
model downloads to ~/.insrc/models/hf-cache on first embed call
(~140 MB, ~30 s cold).

Analyze shaper: routed to your CLI OAuth session (Claude Code
via the multi-turn insrc_analyze_step tool, or Codex CLI).
Ollama is NOT required for this mode.

If you later install Ollama and want to use it:
- ollama pull qwen3-embedding:0.6b
- Update ~/.insrc/config.json embeddingModel/embeddingDim back to Ollama's model + dim.
- rm -rf ~/.insrc/lance && re-add repos.

Next steps:

EOF
else
	cat <<EOF
Embedder: Ollama (auto-detected at $OLLAMA_HOST_URL).

If Ollama's embedding model isn't installed yet, pull it once:

ollama pull qwen3-embedding:0.6b     # ~700 MB
ollama pull qwen3-coder:latest       # ~10 GB (optional; used by the indexer's summariser)

Next steps:

EOF
fi

cat <<EOF
1. Register the MCP tool with your CLI clients:

claude mcp add insrc \\
	-e INSRC_REPO=/absolute/path/to/repo \\
	-- node $INSTALL_ROOT/out/insrc/bin/insrc-mcp.js

codex mcp add insrc \\
	--env INSRC_REPO=/absolute/path/to/repo \\
	-- node $INSTALL_ROOT/out/insrc/bin/insrc-mcp.js

2. Add repos to the index:

cd $DAEMON_SRC
npx --no-install tsx cli/index.ts repo add /path/to/your/code

3. Manage the daemon:

$CTL status         # health check
$CTL restart        # graceful restart
$CTL update         # sync origin, install if lock changed, build, restart

4. Full usage doc:

$INSTALL_ROOT/docs/daemon.md

EOF

exit 0
