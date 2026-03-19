/**
 * Daemon lifecycle management — spawn, health poll, auto-restart.
 *
 * The daemon is spawned as a detached process that outlives any single
 * VS Code window. Multiple windows share the same daemon instance.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tryConnect, createRpcClient, type RpcClient } from './rpc';

const INSRC_HOME = path.join(os.homedir(), '.insrc');
const PID_PATH = path.join(INSRC_HOME, 'daemon.pid');
const DAEMON_DIR = path.join(INSRC_HOME, 'daemon');
const REPO_URL = 'https://github.com/insors-ai/insrc.git';

/** Get extension version from package.json → used as git tag for daemon install. */
function getExtensionVersion(): string {
  try {
    // __dirname is dist/ inside the extension
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.1';
  } catch {
    return '0.0.1';
  }
}
const HEALTH_INTERVAL = 30_000;  // 30s health poll
const POLL_INTERVAL = 500;       // 500ms socket poll during startup
const STARTUP_TIMEOUT = 15_000;  // 15s max wait for daemon
const MAX_RESTART_ATTEMPTS = 3;

export interface DaemonStatus {
  running: boolean;
  uptime?: number;                   // seconds (from daemon)
  queueDepth?: number;
  modelPullStatus?: 'pulling' | 'ready';
  modelPullPct?: number;
  repos?: Array<{ path: string; status: string; lastIndexed?: string }>;
}

export interface DaemonManager {
  /** Ensure daemon is running. Spawns if needed. */
  ensureDaemon(): Promise<boolean>;
  /** Graceful restart (SIGTERM + respawn). */
  restart(): Promise<boolean>;
  /** Force kill the daemon (SIGKILL) and restart. */
  forceRestart(): Promise<boolean>;
  /** Get current daemon status via RPC. */
  getStatus(): Promise<DaemonStatus>;
  /** Get the RPC client for making calls. */
  getClient(): RpcClient;
  /** Start health polling. */
  startHealthPolling(onStatusChange: (status: DaemonStatus) => void): void;
  /** Install daemon (clone repo + npm install into ~/.insrc/daemon/). */
  installDaemon(): Promise<boolean>;
  /** Update daemon (git pull + npm install). */
  updateDaemon(): Promise<boolean>;
  /** Stop health polling and disconnect. */
  dispose(): void;
}

export function createDaemonManager(outputChannel: vscode.OutputChannel): DaemonManager {
  const client = createRpcClient();
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let restartAttempts = 0;
  let lastStatus: DaemonStatus = { running: false };

  function log(msg: string): void {
    outputChannel.appendLine(`[daemon] ${msg}`);
  }

  /**
   * Check if daemon is running by trying socket connection,
   * then falling back to PID file check.
   */
  async function isDaemonRunning(): Promise<boolean> {
    // Method 1: try connecting to socket
    if (await tryConnect()) {
      return true;
    }

    // Method 2: check PID file
    if (fs.existsSync(PID_PATH)) {
      try {
        const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
        process.kill(pid, 0); // signal 0 = alive check
        return true;
      } catch {
        // Stale PID file — daemon is dead
        log('stale PID file detected, cleaning up');
        try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
      }
    }

    return false;
  }

  /**
   * Find the insrc daemon installation.
   * Priority:
   *   1. ~/.insrc/daemon/ (managed install)
   *   2. config.json installPath (explicit override)
   *   3. Any workspace folder containing src/cli/index.ts (dev mode)
   * Returns the root path or null if not found.
   */
  function findDaemonRoot(): string | null {
    // 1. Managed install at ~/.insrc/daemon/
    const managedEntry = path.join(DAEMON_DIR, 'src', 'cli', 'index.ts');
    if (fs.existsSync(managedEntry)) {
      return DAEMON_DIR;
    }

    // 2. Explicit installPath in config
    const configPath = path.join(INSRC_HOME, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.installPath) {
          const entry = path.join(config.installPath, 'src', 'cli', 'index.ts');
          if (fs.existsSync(entry)) {
            return config.installPath;
          }
        }
      } catch { /* ignore */ }
    }

    return null;
  }

  /**
   * Run a shell command and return { ok, stderr }.
   */
  function runCmd(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, stdio: 'pipe' });
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ ok: code === 0, stderr }));
    });
  }

  /**
   * Install the insrc daemon by cloning the repo into ~/.insrc/daemon/
   * and running npm install. Clones the release tag matching the extension
   * version, falls back to main if the tag doesn't exist.
   */
  async function installDaemon(): Promise<boolean> {
    log('installing insrc daemon...');

    if (!fs.existsSync(INSRC_HOME)) {
      fs.mkdirSync(INSRC_HOME, { recursive: true });
    }

    // Remove existing daemon dir if present (clean install)
    if (fs.existsSync(DAEMON_DIR)) {
      log('removing existing daemon dir for clean install');
      fs.rmSync(DAEMON_DIR, { recursive: true, force: true });
    }

    const version = getExtensionVersion();
    const tag = `v${version}`;

    // Try cloning with release tag
    log(`cloning ${REPO_URL} (tag: ${tag}) → ${DAEMON_DIR}`);
    let result = await runCmd('git', ['clone', '--branch', tag, '--depth', '1', REPO_URL, DAEMON_DIR]);

    if (!result.ok) {
      // Tag doesn't exist — fall back to main
      log(`tag ${tag} not found, falling back to main branch`);
      vscode.window.showWarningMessage(`insrc: Release ${tag} not found, using main branch.`);

      // Clean up failed clone attempt
      if (fs.existsSync(DAEMON_DIR)) {
        fs.rmSync(DAEMON_DIR, { recursive: true, force: true });
      }

      result = await runCmd('git', ['clone', '--depth', '1', '--branch', 'main', REPO_URL, DAEMON_DIR]);
      if (!result.ok) {
        log(`git clone main failed: ${result.stderr}`);
        return false;
      }
      log('cloned main branch');
    } else {
      log(`cloned tag ${tag}`);
    }

    // npm install (full — needs tsx for running TypeScript)
    log('running npm install...');
    const npmResult = await runCmd('npm', ['install', '--legacy-peer-deps'], DAEMON_DIR);
    if (!npmResult.ok) {
      log(`npm install failed: ${npmResult.stderr}`);
      return false;
    }

    // Build TypeScript → dist/
    log('building daemon...');
    const buildResult = await runCmd('npm', ['run', 'build'], DAEMON_DIR);
    if (!buildResult.ok) {
      log(`build failed: ${buildResult.stderr} — will use tsx fallback`);
      // Not fatal — spawnDaemon can use npx tsx as fallback
    }

    log('daemon installed successfully');
    return true;
  }

  /**
   * Update the daemon installation — fetch tags, checkout matching version, npm install.
   */
  async function updateDaemon(): Promise<boolean> {
    if (!fs.existsSync(DAEMON_DIR)) return false;

    log('updating daemon...');
    const version = getExtensionVersion();
    const tag = `v${version}`;

    // Fetch latest tags
    let result = await runCmd('git', ['fetch', '--tags', '--depth', '1'], DAEMON_DIR);
    if (!result.ok) {
      log(`git fetch failed: ${result.stderr}`);
      // Try pull instead
      result = await runCmd('git', ['pull', '--ff-only'], DAEMON_DIR);
      if (!result.ok) {
        log(`git pull also failed: ${result.stderr}`);
        return false;
      }
    } else {
      // Try checking out the matching tag
      result = await runCmd('git', ['checkout', tag], DAEMON_DIR);
      if (!result.ok) {
        log(`tag ${tag} not found, pulling main instead`);
        await runCmd('git', ['checkout', 'main'], DAEMON_DIR);
        await runCmd('git', ['pull', '--ff-only'], DAEMON_DIR);
      } else {
        log(`checked out tag ${tag}`);
      }
    }

    // npm install + build
    const npmResult = await runCmd('npm', ['install', '--legacy-peer-deps'], DAEMON_DIR);
    if (!npmResult.ok) {
      log(`npm install failed during update: ${npmResult.stderr}`);
      return false;
    }
    const buildResult = await runCmd('npm', ['run', 'build'], DAEMON_DIR);
    if (!buildResult.ok) {
      log(`build failed during update: ${buildResult.stderr}`);
    }

    log('daemon updated successfully');
    return true;
  }

  /**
   * Spawn the daemon as a detached background process.
   * Uses ~/.insrc/daemon/ (managed install), config.installPath, or workspace folder.
   * If not found, prompts user to install.
   */
  function spawnDaemon(): void {
    log('spawning daemon process...');

    const root = findDaemonRoot();

    if (root) {
      // Prefer compiled dist/ if available, fall back to npx tsx
      const distEntry = path.join(root, 'dist', 'cli', 'index.js');
      const srcEntry = path.join(root, 'src', 'cli', 'index.ts');
      let cmd: string;
      let args: string[];

      if (fs.existsSync(distEntry)) {
        cmd = 'node';
        args = [distEntry, 'daemon', 'start'];
        log(`spawning from ${root} (compiled dist/)`);
      } else {
        cmd = 'npx';
        args = ['tsx', srcEntry, 'daemon', 'start'];
        log(`spawning from ${root} (tsx fallback)`);
      }

      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        cwd: root,
        env: { ...process.env },
      });
      child.unref();
      log(`daemon spawned (child PID: ${child.pid})`);
    } else {
      log('insrc daemon not found — prompting install');
      vscode.window.showWarningMessage(
        'insrc daemon not installed. Install now?',
        'Install',
        'Set Path Manually',
      ).then(async (action) => {
        if (action === 'Install') {
          const success = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'insrc: Installing daemon...' },
            () => installDaemon(),
          );
          if (success) {
            vscode.window.showInformationMessage('insrc daemon installed. Starting...');
            spawnDaemon(); // retry after install
          } else {
            vscode.window.showErrorMessage(
              'insrc daemon installation failed. Check the output channel for details.',
            );
          }
        } else if (action === 'Set Path Manually') {
          const configFile = path.join(INSRC_HOME, 'config.json');
          if (fs.existsSync(configFile)) {
            vscode.workspace.openTextDocument(configFile).then(doc => {
              vscode.window.showTextDocument(doc);
            });
          }
          vscode.window.showInformationMessage(
            'Add "installPath": "/path/to/insrc" to ~/.insrc/config.json, then restart.',
          );
        }
      });
    }
  }

  /**
   * Wait for the daemon socket to become available.
   */
  function waitForSocket(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const poll = (): void => {
        tryConnect().then((connected) => {
          if (connected) {
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            resolve(false);
          } else {
            setTimeout(poll, POLL_INTERVAL);
          }
        }).catch(() => {
          if (Date.now() - start > timeoutMs) {
            resolve(false);
          } else {
            setTimeout(poll, POLL_INTERVAL);
          }
        });
      };
      poll();
    });
  }

  /**
   * Ensure daemon is running. Spawns and waits if needed.
   */
  async function ensureDaemon(): Promise<boolean> {
    if (await isDaemonRunning()) {
      log('daemon already running');
      restartAttempts = 0;
      // Check for updates in background (once per day)
      checkForUpdatesIfDue();
      return true;
    }

    log('daemon not running, starting...');
    spawnDaemon();

    const ready = await waitForSocket(STARTUP_TIMEOUT);
    if (ready) {
      log('daemon ready');
      restartAttempts = 0;
      checkForUpdatesIfDue();
      return true;
    }

    log('daemon failed to start within timeout');
    return false;
  }

  /**
   * Check for daemon updates once per day. Non-blocking — runs in background.
   */
  function checkForUpdatesIfDue(): void {
    if (!fs.existsSync(DAEMON_DIR)) return;

    const UPDATE_CHECK_FILE = path.join(INSRC_HOME, '.last-update-check');
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    try {
      if (fs.existsSync(UPDATE_CHECK_FILE)) {
        const lastCheck = parseInt(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8').trim(), 10);
        if (Date.now() - lastCheck < ONE_DAY_MS) return; // checked recently
      }
    } catch { /* proceed with check */ }

    // Mark as checked now (even before the actual check, to avoid repeated checks on failure)
    try { fs.writeFileSync(UPDATE_CHECK_FILE, String(Date.now())); } catch { /* ignore */ }

    // Run git fetch --dry-run in background to see if there are new commits
    log('checking for daemon updates (daily)...');
    const { spawn: spawnProc } = require('node:child_process');
    const child = spawnProc('git', ['fetch', '--dry-run'], { cwd: DAEMON_DIR, stdio: 'pipe' });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number) => {
      if (code === 0 && stderr.trim().length > 0) {
        // There are new commits available
        log('daemon update available');
        vscode.window.showInformationMessage(
          'insrc: Daemon update available.',
          'Update Now',
          'Later',
        ).then((action) => {
          if (action === 'Update Now') {
            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: 'insrc: Updating daemon...' },
              async () => {
                const success = await updateDaemon();
                if (success) {
                  vscode.window.showInformationMessage('insrc daemon updated. Restart to apply.', 'Restart').then((r) => {
                    if (r === 'Restart') restart();
                  });
                } else {
                  vscode.window.showErrorMessage('insrc daemon update failed. Check output channel.');
                }
              },
            );
          }
        });
      } else {
        log('daemon is up to date');
      }
    });
  }

  /**
   * Query daemon status via RPC.
   */
  async function getStatus(): Promise<DaemonStatus> {
    try {
      const result = await client.call<{
        uptime?: number;
        queueDepth?: number;
        modelPullStatus?: 'pulling' | 'ready';
        modelPullPct?: number;
        repos?: Array<{ path: string; status: string; lastIndexed?: string }>;
      }>('daemon.status');

      lastStatus = {
        running: true,
        uptime: result.uptime,
        queueDepth: result.queueDepth,
        modelPullStatus: result.modelPullStatus,
        modelPullPct: result.modelPullPct,
        repos: result.repos,
      };

      restartAttempts = 0;
      return lastStatus;
    } catch {
      lastStatus = { running: false };
      return lastStatus;
    }
  }

  /**
   * Start periodic health polling.
   */
  function startHealthPolling(onStatusChange: (status: DaemonStatus) => void): void {
    if (healthTimer) return;

    healthTimer = setInterval(async () => {
      const prevRunning = lastStatus.running;
      const status = await getStatus();

      // Detect daemon crash — was running, now not
      if (prevRunning && !status.running) {
        log('daemon appears to have crashed');

        if (restartAttempts < MAX_RESTART_ATTEMPTS) {
          restartAttempts++;
          log(`auto-restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

          const restarted = await ensureDaemon();
          if (restarted) {
            const newStatus = await getStatus();
            onStatusChange(newStatus);
            return;
          }
        }

        if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
          vscode.window.showErrorMessage(
            'insrc daemon is unavailable. Click to retry.',
            'Retry',
          ).then((action) => {
            if (action === 'Retry') {
              restartAttempts = 0;
              ensureDaemon().then(() => getStatus()).then(onStatusChange);
            }
          });
        }
      }

      onStatusChange(status);
    }, HEALTH_INTERVAL);
  }

  /**
   * Graceful restart — SIGTERM, wait up to 5s, then respawn.
   */
  async function restart(): Promise<boolean> {
    log('restarting daemon (graceful)...');
    await killDaemon('SIGTERM', 5000);
    restartAttempts = 0;
    return ensureDaemon();
  }

  /**
   * Force kill daemon (SIGKILL), clean up PID/socket files, and respawn.
   */
  async function forceRestart(): Promise<boolean> {
    log('force restarting daemon (SIGKILL)...');
    await killDaemon('SIGKILL', 500);
    restartAttempts = 0;
    return ensureDaemon();
  }

  /**
   * Stop the daemon cleanly via RPC, falling back to signals if RPC fails.
   */
  async function killDaemon(signal: 'SIGTERM' | 'SIGKILL', waitMs: number): Promise<void> {
    // Try clean shutdown via RPC first (same as CLI `insrc daemon stop`)
    if (signal === 'SIGTERM') {
      try {
        log('requesting clean shutdown via daemon.shutdown RPC');
        await client.call('daemon.shutdown');
        // Wait for PID file to disappear (up to 5s)
        for (let i = 0; i < 50; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (!fs.existsSync(PID_PATH)) {
            log('daemon stopped cleanly via RPC');
            return;
          }
        }
        log('daemon.shutdown RPC sent but PID still exists — falling back to signal');
      } catch {
        log('daemon.shutdown RPC failed — falling back to signal');
      }
    }

    // Fallback: send signal directly to process
    if (fs.existsSync(PID_PATH)) {
      try {
        const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
        log(`sending ${signal} to PID ${pid}`);
        process.kill(pid, signal);
      } catch {
        log('PID kill failed (process may already be dead)');
      }
    }

    // Wait for process to exit
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // Clean up stale files
    try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(os.homedir(), '.insrc', 'daemon.sock')); } catch { /* ignore */ }
  }

  function dispose(): void {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    client.disconnect();
    log('disconnected');
  }

  return {
    ensureDaemon,
    restart,
    forceRestart,
    getStatus,
    getClient: () => client,
    startHealthPolling,
    installDaemon,
    updateDaemon,
    dispose,
  };
}
