import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

/**
 * `/om:toggle` — enable or disable observational memory for the current session.
 *
 * Disabling maps to `config.passive = true`, the same mode the
 * `observational-memory.passive` setting and `PI_OBSERVATIONAL_MEMORY_PASSIVE`
 * environment variable select at startup: automatic consolidation
 * (observer/reflector/dropper) and OM's proactive auto-compaction stop firing,
 * while `/om:status`, `/om:view`, `recall`, and OM-owned compaction summaries
 * stay available. Re-enabling flips `passive` back to false, so the next
 * `agent_start` / `turn_end` / `agent_settled` re-checks thresholds and runs
 * any consolidation or compaction that came due while disabled.
 *
 * The toggle is session-scoped: it mutates the loaded `runtime.config` in place
 * (`ensureConfig` caches it), so a new session starts from the configured
 * default again. To persist the choice, set
 * `"observational-memory": { "passive": true }` in settings.json.
 */

type ToggleIntent = "on" | "off";

function parseIntent(args: string): ToggleIntent | "toggle" | "invalid" {
	const value = args.trim().toLowerCase();
	if (value === "") return "toggle";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}

export function registerToggleCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:toggle", {
		description: "Enable or disable observational memory workers and auto-compaction for this session",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{ value: "on", label: "on", description: "Enable workers and auto-compaction" },
				{ value: "off", label: "off", description: "Disable workers and auto-compaction" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const intent = parseIntent(args);
			if (intent === "invalid") {
				ctx.ui.notify("Usage: /om:toggle [on|off] — without an argument it flips the current state", "info");
				return;
			}

			const currentlyDisabled = runtime.config.passive === true;
			const disabled = intent === "toggle" ? !currentlyDisabled : intent === "off";
			if (disabled === currentlyDisabled) {
				ctx.ui.notify(
					`Observational memory is already ${disabled ? "disabled" : "enabled"}.`,
					"info",
				);
				return;
			}
			runtime.config.passive = disabled;

			if (disabled) {
				// In-flight work cannot be cancelled; it settles on its own.
				const inFlight = runtime.consolidationInFlight || runtime.compactInFlight
					? " An in-flight run will finish; no new work will start."
					: "";
				ctx.ui.notify(
					`Observational memory: disabled — automatic consolidation and auto-compaction suspended for this session.${inFlight} /om:status, /om:view, recall, and compaction summaries remain available.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				"Observational memory: enabled — consolidation and auto-compaction resume on the next turn/settle.",
				"info",
			);
		},
	});
}
