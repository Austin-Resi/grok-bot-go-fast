import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DevToolsActivePort {
  port: number;
  path: string;
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

function processArgs(): string {
  try {
    return execFileSync("ps", ["-eo", "args="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 2_000_000,
    });
  } catch {
    return "";
  }
}

async function discoverFromProfiles(dirs: string[]): Promise<string | undefined> {
  for (const dir of dirs) {
    const active = readDevToolsActivePort(dir);
    if (active && (await probePort(active.port))) return devToolsEndpoint(active);
  }
  return undefined;
}

async function discoverFromHttp(port: number | undefined): Promise<string | undefined> {
  const candidates = [...new Set([...(port ? [cdpEndpoint(port)] : []), cdpEndpoint(9222)])];
  for (const url of candidates) {
    if (await probeCdp(url)) return url;
  }
  return undefined;
}

export async function discoverCdpUrl(): Promise<string | undefined> {
  const explicit = process.env.CDP_URL?.trim();
  if (explicit) {
    if (isWebSocketUrl(explicit)) return explicit;
    if (!(await probeCdp(explicit, 1500))) {
      throw new Error(
        `CDP_URL ${explicit} did not answer /json/version. Chrome 144+ enabled via chrome://inspect/#remote-debugging exposes only a WebSocket endpoint; use the ws:// URL from <profile>/DevToolsActivePort, or unset CDP_URL and let Jev read that file.`,
      );
    }
    return explicit;
  }

  if (process.env.JEV_CDP_DISCOVER === "false") return undefined;

  const args = processArgs();
  const profiles = [...new Set([...parseUserDataDirs(args), ...defaultProfileDirs()])];
  return (await discoverFromProfiles(profiles)) ?? (await discoverFromHttp(parseRemoteDebuggingPort(args)));
}
