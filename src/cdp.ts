import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setting, settingIs } from "./env.ts";

export interface DevToolsActivePort {
  port: number;
  path: string;
}

export interface ChromeProcess {
  pid: number;
  args: string;
  userDataDir?: string;
}

export interface CdpAttachment {
  url: string;
  /** Profile directory whose DevToolsActivePort was used, when known. */
  profileDir?: string;
  /** X display the discovery was scoped to, when known. */
  display?: string;
}

/**
 * Browser (non-child) Chrome/Chromium processes from `ps -eo pid=,args=`.
 * Renderer/GPU children carry --type=... and are skipped.
 */
export function parseChromeProcesses(psOutput: string): ChromeProcess[] {
  const processes: ChromeProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2];
    if (!/chrom(e|ium)/i.test(args) || /--type=/.test(args)) continue;
    if (/^(\S*\/)?(grep|rg|node|tsx|npx)\b/.test(args)) continue;
    processes.push({ pid: Number(match[1]), args, userDataDir: parseUserDataDirs(args)[0] });
  }
  return processes;
}

/** DISPLAY from a process environment. Linux only; undefined elsewhere or when unreadable. */
export function readProcessDisplay(pid: number): string | undefined {
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "latin1");
    for (const entry of environ.split("\0")) {
      if (entry.startsWith("DISPLAY=")) return entry.slice("DISPLAY=".length);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Keep only Chromes running on `display`. A process whose environment cannot be
 * read is excluded: attaching to an unknown display is exactly the failure mode
 * this guards against.
 */
export function scopeToDisplay(
  processes: ChromeProcess[],
  display: string,
  readDisplay: (pid: number) => string | undefined = readProcessDisplay,
): ChromeProcess[] {
  const wanted = normalizeDisplay(display);
  return processes.filter((process) => {
    const actual = readDisplay(process.pid);
    return actual != null && normalizeDisplay(actual) === wanted;
  });
}

/** ":14", ":14.0", "localhost:14", "unix:14" all mean display 14. */
export function normalizeDisplay(display: string): string {
  const match = /:(\d+)(?:\.\d+)?$/.exec(display.trim());
  return match ? `:${match[1]}` : display.trim();
}

export function parseRemoteDebuggingPort(processArgs: string): number | undefined {
  const matches = processArgs.matchAll(/--remote-debugging-port(?:=|\s+)(\d+)/gi);
  for (const match of matches) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
}

export function parseUserDataDirs(processArgs: string): string[] {
  const dirs = new Set<string>();
  for (const match of processArgs.matchAll(/--user-data-dir(?:=|\s+)("([^"]+)"|'([^']+)'|(\S+))/g)) {
    const dir = match[2] ?? match[3] ?? match[4];
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}

export function defaultProfileDirs(platform = process.platform, home = homedir()): string[] {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      join(base, "Google", "Chrome"),
      join(base, "Google", "Chrome Beta"),
      join(base, "Google", "Chrome Canary"),
      join(base, "Chromium"),
    ];
  }
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(local, "Google", "Chrome", "User Data"),
      join(local, "Google", "Chrome Beta", "User Data"),
      join(local, "Chromium", "User Data"),
    ];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(config, "google-chrome"),
    join(config, "google-chrome-beta"),
    join(config, "google-chrome-unstable"),
    join(config, "chromium"),
  ];
}

// Chrome writes `<port>\n<browser target path>` here whenever a DevTools
// endpoint is live, including the Chrome 144+ chrome://inspect toggle that
// exposes only the WebSocket endpoint (no /json/version).
export function readDevToolsActivePort(profileDir: string): DevToolsActivePort | undefined {
  let text: string;
  try {
    text = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
  } catch {
    return undefined;
  }
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number(portLine?.trim());
  const path = pathLine?.trim();
  if (!Number.isInteger(port) || port <= 0 || !path?.startsWith("/devtools/browser/")) return undefined;
  return { port, path };
}

export function devToolsEndpoint(active: DevToolsActivePort): string {
  return `ws://127.0.0.1:${active.port}${active.path}`;
}

export function cdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

export async function probeCdp(url: string, timeoutMs = 400): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function probePort(port: number, host = "127.0.0.1", timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function processTable(): string {
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4_000_000,
    });
  } catch {
    return "";
  }
}

async function discoverFromProfiles(dirs: string[]): Promise<{ url: string; profileDir: string } | undefined> {
  for (const dir of dirs) {
    const active = readDevToolsActivePort(dir);
    if (active && (await probePort(active.port))) return { url: devToolsEndpoint(active), profileDir: dir };
  }
  return undefined;
}

async function discoverFromHttp(ports: number[]): Promise<string | undefined> {
  for (const port of new Set(ports)) {
    const url = cdpEndpoint(port);
    if (await probeCdp(url)) return url;
  }
  return undefined;
}

/**
 * Find the Chrome this agent should drive.
 *
 * Order: CDP_URL → CRACK_BOT_CDP_PROFILE_DIR → Chromes on this DISPLAY (Linux, via
 * /proc/<pid>/environ) → all Chromes when no DISPLAY scoping is possible.
 * When DISPLAY is set and no Chrome on it exposes DevTools, returns undefined
 * so the caller launches its own browser on this display rather than driving
 * another agent's session.
 */
export async function discoverCdp(): Promise<CdpAttachment | undefined> {
  const explicit = process.env.CDP_URL?.trim();
  if (explicit) {
    if (isWebSocketUrl(explicit)) return { url: explicit };
    if (!(await probeCdp(explicit, 1500))) {
      throw new Error(
        `CDP_URL ${explicit} did not answer /json/version. Chrome 144+ enabled via chrome://inspect/#remote-debugging exposes only a WebSocket endpoint; use the ws:// URL from <profile>/DevToolsActivePort, or unset CDP_URL and let Jev read that file.`,
      );
    }
    return { url: explicit };
  }

  if (settingIs("CDP_DISCOVER", "false")) return undefined;

  const pinned = setting("CDP_PROFILE_DIR");
  if (pinned) {
    const found = await discoverFromProfiles([pinned]);
    if (!found) {
      throw new Error(
        `CRACK_BOT_CDP_PROFILE_DIR ${pinned} has no live DevToolsActivePort. Enable chrome://inspect/#remote-debugging in that Chrome, or unset the variable.`,
      );
    }
    return found;
  }

  const display = setting("CDP_DISPLAY") || process.env.DISPLAY?.trim() || undefined;
  const all = parseChromeProcesses(processTable());
  const canScope = display != null && existsSync("/proc");
  const scoped = canScope ? scopeToDisplay(all, display) : all;

  const profiles = new Set<string>();
  for (const process of scoped) if (process.userDataDir) profiles.add(process.userDataDir);
  // Default profile dirs only when a matching Chrome runs without --user-data-dir,
  // or when we cannot scope at all (single-user macOS/Windows).
  if (!canScope || scoped.some((process) => !process.userDataDir)) {
    for (const dir of defaultProfileDirs()) profiles.add(dir);
  }

  const fromProfiles = await discoverFromProfiles([...profiles]);
  if (fromProfiles) return { ...fromProfiles, display };

  const ports = scoped.map((process) => parseRemoteDebuggingPort(process.args)).filter((p): p is number => p != null);
  if (!canScope) ports.push(9222);
  const url = await discoverFromHttp(ports);
  return url ? { url, display } : undefined;
}

export async function discoverCdpUrl(): Promise<string | undefined> {
  return (await discoverCdp())?.url;
}
