/** Shared launch-time Herdr layout and agent-start helpers. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Multiple subagent tool calls can arrive in the same turn. Herdr layout
// mutations are not transactional, so serialize the snapshot/split/stage/
// reflow sequence to prevent concurrent launches from interleaving.
let layoutQueue: Promise<void> = Promise.resolve();

async function withLayoutLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = layoutQueue;
  let release!: () => void;
  layoutQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

type SplitDirection = "right" | "down";

type PaneRect = {
  pane_id: string;
  rect: { x: number; y: number; width: number; height: number };
};

type LayoutSnapshot = {
  workspace_id: string;
  tab_id: string;
  panes: PaneRect[];
};

type InsertOperation = {
  source: string;
  target: string;
  direction: SplitDirection;
  ratio: number;
};

function herdrBinary(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Herdr is required for managed pane layouts.");
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

export async function herdrJson(args: string[]): Promise<any> {
  requireHerdr();
  const { stdout } = await execFileAsync(herdrBinary(), args, herdrOptions());
  const output = stdout.trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Herdr returned invalid JSON: ${output || "(empty response)"}`);
  }
}

async function herdrText(args: string[]): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(herdrBinary(), args, herdrOptions());
  return stdout;
}

function paneOrder(snapshot: LayoutSnapshot, anchorPaneId: string): string[] {
  const ids = snapshot.panes
    .slice()
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map((pane) => pane.pane_id);

  if (!ids.includes(anchorPaneId)) {
    throw new Error(`Current pane ${anchorPaneId} is not in Herdr tab ${snapshot.tab_id}.`);
  }

  // The orchestrator is the oldest pane and therefore remains the first pane
  // in every layout produced by this module. If a caller enters through a
  // child pane, spatial order still preserves the launch order from the last
  // layout pass without a continuously maintained pane/session registry.
  return ids;
}

async function readLayout(paneId: string): Promise<LayoutSnapshot> {
  const response = await herdrJson(["pane", "layout", "--pane", paneId]);
  const layout = response?.result?.layout;
  if (!layout?.workspace_id || !layout?.tab_id || !Array.isArray(layout.panes)) {
    throw new Error("Herdr did not return a usable pane layout.");
  }
  return layout as LayoutSnapshot;
}

function gridRowCounts(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
}

function gridOperations(ids: string[]): InsertOperation[] {
  const count = ids.length;
  const rows = count >= 6 ? Math.max(2, Math.floor(Math.sqrt(count))) : count >= 4 ? 2 : 1;
  const counts = gridRowCounts(count, rows);
  const operations: InsertOperation[] = [];

  const rowStarts: number[] = [];
  let offset = 0;
  for (const rowCount of counts) {
    rowStarts.push(offset);
    offset += rowCount;
  }

  // Build row groups from top to bottom. The existing pane keeps the first
  // fraction and the newly inserted pane receives the remaining fraction.
  let rowTarget = ids[0];
  for (let row = 1; row < rows; row++) {
    const source = ids[rowStarts[row]];
    operations.push({
      source,
      target: rowTarget,
      direction: "down",
      ratio: 1 / (rows - row + 1),
    });
    rowTarget = source;
  }

  // Build each row from left to right with equal-width cells.
  for (let row = 0; row < rows; row++) {
    const rowStart = rowStarts[row];
    const rowCount = counts[row];
    let target = ids[rowStart];
    for (let column = 1; column < rowCount; column++) {
      const source = ids[rowStart + column];
      operations.push({
        source,
        target,
        direction: "right",
        ratio: 1 / (rowCount - column + 1),
      });
      target = source;
    }
  }

  return operations;
}

function fivePaneOperations(ids: string[]): InsertOperation[] {
  // Orchestrator full-height on the left; four later sessions form a 2x2
  // grid in the remaining right-hand area.
  return [
    { source: ids[1], target: ids[0], direction: "right", ratio: 1 / 3 },
    { source: ids[3], target: ids[1], direction: "down", ratio: 0.5 },
    { source: ids[2], target: ids[1], direction: "right", ratio: 0.5 },
    { source: ids[4], target: ids[3], direction: "right", ratio: 0.5 },
  ];
}

function layoutOperations(ids: string[]): InsertOperation[] {
  return ids.length === 5 ? fivePaneOperations(ids) : gridOperations(ids);
}

async function movePaneToTab(
  paneId: string,
  tabId: string,
  direction: SplitDirection,
  targetPaneId: string,
  ratio: number,
): Promise<void> {
  const args = [
    "pane",
    "move",
    paneId,
    "--tab",
    tabId,
    "--split",
    direction,
    "--target-pane",
    targetPaneId,
    "--ratio",
    String(ratio),
    "--no-focus",
  ];
  await herdrJson(args);
}

async function stagePanes(
  paneIds: string[],
  workspaceId: string,
): Promise<{ tabId: string; rootPaneId: string }> {
  const first = await herdrJson([
    "pane",
    "move",
    paneIds[0],
    "--new-tab",
    "--workspace",
    workspaceId,
    "--no-focus",
  ]);
  const moveResult = first?.result?.move_result;
  const tabId = moveResult?.created_tab?.tab_id ?? moveResult?.pane?.tab_id;
  const rootPaneId = moveResult?.pane?.pane_id;
  if (typeof tabId !== "string" || typeof rootPaneId !== "string") {
    throw new Error("Herdr did not return the staging tab after moving a pane.");
  }

  for (const paneId of paneIds.slice(1)) {
    await movePaneToTab(paneId, tabId, "right", rootPaneId, 0.5);
  }

  return { tabId, rootPaneId };
}

async function reflowLayout(
  snapshot: LayoutSnapshot,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length <= 1) return;

  const staging = await stagePanes(orderedIds.slice(1), snapshot.workspace_id);
  for (const operation of layoutOperations(orderedIds)) {
    await movePaneToTab(
      operation.source,
      snapshot.tab_id,
      operation.direction,
      operation.target,
      operation.ratio,
    );
  }

  // The staging tab closes automatically when its last pane is moved back.
  void staging;
}

async function reflowManagedLayoutUnlocked(anchorPaneId: string): Promise<void> {
  const snapshot = await readLayout(anchorPaneId);
  const orderedIds = paneOrder(snapshot, anchorPaneId);
  await reflowLayout(snapshot, orderedIds);
}

/**
 * Reflow the remaining managed panes after one pane has been closed.
 */
export function reflowManagedLayout(anchorPaneId = process.env.HERDR_PANE_ID): Promise<void> {
  if (!anchorPaneId) return Promise.reject(new Error("HERDR_PANE_ID is required for managed layouts."));
  return withLayoutLock(() => reflowManagedLayoutUnlocked(anchorPaneId));
}

/**
 * Create the next managed pane and reflow the entire current tab at launch
 * time. No pane/session watcher or persistent mapping is required.
 */
async function prepareManagedPaneUnlocked(options: {
  paneId?: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<string> {
  requireHerdr();
  const anchorPaneId = options.paneId ?? process.env.HERDR_PANE_ID;
  if (!anchorPaneId) throw new Error("HERDR_PANE_ID is required for managed layouts.");

  const before = await readLayout(anchorPaneId);
  const existingIds = paneOrder(before, anchorPaneId);
  const splitArgs = [
    "pane",
    "split",
    "--pane",
    anchorPaneId,
    "--direction",
    "right",
    "--no-focus",
  ];
  if (options.cwd) splitArgs.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    splitArgs.push("--env", `${key}=${value}`);
  }

  const split = await herdrJson(splitArgs);
  const newPaneId = split?.result?.pane?.pane_id;
  if (typeof newPaneId !== "string" || !newPaneId) {
    throw new Error("Herdr did not return the new pane ID.");
  }

  const orderedIds = [...existingIds, newPaneId];
  await reflowLayout(before, orderedIds);
  return newPaneId;
}

export function prepareManagedPane(options: {
  paneId?: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<string> {
  return withLayoutLock(() => prepareManagedPaneUnlocked(options));
}

/** Wait asynchronously for a newly-created pane's shell prompt. */
export async function waitForPaneReady(paneId: string): Promise<void> {
  for (;;) {
    const output = await herdrText([
      "pane",
      "read",
      paneId,
      "--source",
      "recent-unwrapped",
      "--lines",
      "10",
      "--format",
      "text",
    ]);
    if (output.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Start an agent and propagate Herdr's readiness/errors to the caller. */
export function startHerdrAgent(
  paneId: string,
  herdrName: string,
  kind: string,
  args: string[],
): Promise<boolean> {
  requireHerdr();
  return new Promise((resolve, reject) => {
    const child = spawn(
      herdrBinary(),
      ["agent", "start", herdrName, "--kind", kind, "--pane", paneId, "--", ...args],
      { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      const output = `${stderr}\n${stdout}`;
      // Herdr's startup timeout is ambiguous: the process may have started and
      // even exited before detection completed. Let the caller watch its session
      // completion sidecar rather than dropping an already-running subagent.
      if (/\"code\"\s*:\s*\"timeout\"/.test(output)) {
        resolve(false);
        return;
      }
      reject(
        new Error(
          `Herdr failed to start ${kind} agent '${herdrName}' in pane ${paneId} (exit ${code}). ` +
            (output.trim() || "No diagnostic output."),
        ),
      );
    });
  });
}
