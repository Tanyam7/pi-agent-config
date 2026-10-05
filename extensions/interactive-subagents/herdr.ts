/** Herdr pane integration for interactive subagents. */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const commandAvailability = new Map<string, boolean>();

function herdrBinary(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function hasHerdrBinary(): boolean {
  const binary = herdrBinary();
  if (commandAvailability.has(binary)) return commandAvailability.get(binary)!;

  try {
    execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: "ignore",
      windowsHide: true,
    });
    commandAvailability.set(binary, true);
    return true;
  } catch {
    commandAvailability.set(binary, false);
    return false;
  }
}

/** Herdr is intentionally the only supported pane host. */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasHerdrBinary();
}

export function herdrSetupHint(): string {
  return "Run Pi inside Herdr so it has HERDR_ENV=1 and a Herdr pane.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${herdrSetupHint()}`);
  }
}

function herdrOptions() {
  return {
    encoding: "utf8" as const,
    env: process.env,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  };
}

function runHerdr(args: string[]): string {
  requireHerdr();
  return execFileSync(herdrBinary(), args, herdrOptions()).trim();
}

async function runHerdrAsync(args: string[]): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(herdrBinary(), args, herdrOptions());
  return stdout.trim();
}

function parseJson(output: string): any {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Herdr returned invalid JSON: ${output || "(empty response)"}`);
  }
}

/** Deliver a follow-up to a Pi/Claude agent recognized by Herdr. */
export function sendCommand(paneId: string, message: string): void {
  runHerdr(["agent", "prompt", paneId, message]);
}

export function readScreen(paneId: string, lines = 50): string {
  return runHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
    "--format",
    "text",
  ]);
}

export function closeSurface(paneId: string): void {
  if (!isHerdrAvailable()) return;
  runHerdr(["pane", "close", paneId]);
}

async function surfaceExists(paneId: string): Promise<boolean> {
  try {
    const response = parseJson(await runHerdrAsync(["pane", "get", paneId]));
    return typeof response?.result?.pane?.pane_id === "string";
  } catch {
    return false;
  }
}

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error.";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export async function pollForExit(
  paneId: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    doneFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.doneFile) {
      try {
        if (existsSync(options.doneFile)) {
          rmSync(options.doneFile, { force: true });
          return { reason: "done", exitCode: 0 };
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    if (!(await surfaceExists(paneId))) {
      return {
        reason: "error",
        exitCode: 1,
        errorMessage: "The Herdr agent pane exited before it reported completion.",
      };
    }

    options.onTick?.(Date.now() - start);
    await new Promise((resolve) => setTimeout(resolve, options.interval));
  }
}
