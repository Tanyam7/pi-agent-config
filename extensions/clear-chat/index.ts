// Add /clear: clear the visible transcript without changing session context.
// @ts-nocheck

function hideNextTranscript(ctx: any): () => void {
  const manager = ctx.sessionManager;
  const original = manager.buildContextEntries;
  let firstCall = true;

  manager.buildContextEntries = (...args: any[]) => {
    if (firstCall) {
      firstCall = false;
      manager.buildContextEntries = original;
      return [];
    }
    return original.apply(manager, args);
  };

  return () => {
    if (firstCall) manager.buildContextEntries = original;
  };
}

export default function (pi: any) {
  pi.registerCommand("clear", {
    description: "Clear the visible chat while preserving context",
    handler: async (_args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/clear is only available in the interactive Pi UI.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for Pi to finish before clearing the chat.", "warning");
        return;
      }

      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify("The chat is already clear.", "info");
        return;
      }

      const restore = hideNextTranscript(ctx);
      try {
        await ctx.navigateTree(leafId);
        restore();
        ctx.ui.notify("Cleared the visible chat; context preserved.", "info");
      } catch (error) {
        restore();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not clear the visible chat: ${message}`, "error");
      }
    },
  });
}
