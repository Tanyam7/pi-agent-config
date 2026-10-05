// Add /side and /close for Herdr pane-based Pi sessions.
// @ts-nocheck

import { unlinkSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  herdrJson,
  prepareManagedPane,
  reflowManagedLayout,
  startHerdrAgent,
  waitForPaneReady,
} from "./layout.ts";
const SIDE_SESSION_PREFIX = "side-";

function hideSideTranscript(ctx: any): void {
  const manager = ctx.sessionManager;
  const original = manager.buildContextEntries;
  if (typeof original !== "function") return;

  let firstCall = true;
  manager.buildContextEntries = (...args: any[]) => {
    if (firstCall) {
      firstCall = false;
      manager.buildContextEntries = original;
      return [];
    }
    return original.apply(manager, args);
  };
}

function getLeafId(ctx: any): string | undefined {
  const manager = ctx.sessionManager;
  if (typeof manager.getLeafId === "function") {
    return manager.getLeafId() || undefined;
  }
  return manager.getBranch?.().at(-1)?.id;
}

function createSavedStateSnapshot(sessionFile: string, leafId: string): string {
  // Open a separate manager so creating the snapshot cannot switch the main pane's session.
  const source = SessionManager.open(sessionFile);
  const snapshot = source.createBranchedSession(leafId);
  if (!snapshot) throw new Error("Could not create a saved-state snapshot.");
  return snapshot;
}

export default function (pi: any) {
  let lastSavedLeafId: string | undefined;

  const rememberSavedLeaf = (ctx: any) => {
    lastSavedLeafId = getLeafId(ctx);
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    rememberSavedLeaf(ctx);
    if (ctx.mode !== "tui") return;
    const name = ctx.sessionManager.getSessionName();
    const parentSession = ctx.sessionManager.getHeader()?.parentSession;
    if (parentSession && name?.startsWith(SIDE_SESSION_PREFIX)) {
      hideSideTranscript(ctx);
    }
  });

  pi.registerCommand("close", {
    description: "Close this Pi session and its Herdr pane",
    handler: async (_args: string, ctx: any) => {
      const paneId = process.env.HERDR_PANE_ID;
      if (process.env.HERDR_ENV !== "1" || !paneId) {
        ctx.shutdown();
        return;
      }

      try {
        const before = await herdrJson(["pane", "layout", "--pane", paneId]);
        const panes = before?.result?.layout?.panes;
        const anchorPaneId = Array.isArray(panes)
          ? panes
              .filter((pane: any) => pane?.pane_id && pane.pane_id !== paneId)
              .sort((a: any, b: any) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0]?.pane_id
          : undefined;

        await herdrJson(["pane", "close", paneId]);
        if (anchorPaneId) {
          await reflowManagedLayout(anchorPaneId).catch(() => undefined);
        }
        ctx.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not close Herdr pane: ${message}`, "error");
      }
    },
  });

  pi.on("agent_start", (_event: any, ctx: any) => {
    rememberSavedLeaf(ctx);
  });

  pi.on("agent_settled", (_event: any, ctx: any) => {
    if (ctx.isIdle?.() === true) rememberSavedLeaf(ctx);
  });

  const openSideSession = async (ctx: any, fork: boolean): Promise<void> => {
    if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
      ctx.ui.notify("This command only works inside Herdr.", "warning");
      return;
    }

    // While running, use the leaf captured at agent_start. That excludes the
    // current prompt, assistant response, and any tool results from this side session.
    const leafId = ctx.isIdle() ? getLeafId(ctx) : lastSavedLeafId;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const savedBranch = leafId ? ctx.sessionManager.getBranch(leafId) : [];
    const hasCompletedResponse = savedBranch.some(
      (entry: any) => entry.type === "message" && entry.message?.role === "assistant",
    );
    const canFork = fork && Boolean(sessionFile && leafId && hasCompletedResponse);

    let paneId: string | undefined;
    let snapshotFile: string | undefined;
    let startAttempted = false;
    try {
      // /new:side intentionally never creates a snapshot or passes --session.
      // /side forks the last completed saved state when one is available.
      if (canFork) {
        snapshotFile = createSavedStateSnapshot(sessionFile!, leafId!);
      }

      paneId = await prepareManagedPane({
        paneId: process.env.HERDR_PANE_ID,
        cwd: ctx.cwd,
      });
      await waitForPaneReady(paneId);

      const name = `${fork ? "side" : "new-side"}-${Date.now().toString(36)}`;
      const startArgs: string[] = [];
      if (snapshotFile) startArgs.push("--session", snapshotFile);
      startArgs.push("--name", name);

      const agentReady = await startHerdrAgent(paneId, name, "pi", startArgs);
      startAttempted = true;
      ctx.ui.notify(
        agentReady
          ? snapshotFile
            ? "Opened a forked Pi session on the right."
            : "Opened a fresh Pi session on the right."
          : "Pi was started, but Herdr did not confirm readiness before timeout.",
        agentReady ? "info" : "warning",
      );
    } catch (error) {
      if (paneId && !startAttempted) {
        await herdrJson(["pane", "close", paneId]).catch(() => undefined);
      }
      if (snapshotFile && !startAttempted) {
        try {
          unlinkSync(snapshotFile);
        } catch {
          // Best-effort cleanup only.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open side session: ${message}`, "error");
    }
  };

  pi.registerCommand("side", {
    description: "Open a forked Pi session in a managed Herdr pane",
    handler: async (_args: string, ctx: any) => openSideSession(ctx, true),
  });

  pi.registerCommand("new:side", {
    description: "Open a fresh Pi session in a managed Herdr pane",
    handler: async (_args: string, ctx: any) => openSideSession(ctx, false),
  });
}
