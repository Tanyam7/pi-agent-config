import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    CONFIG_DIR_NAME,
    CustomEditor,
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Default lines scrolled per mouse-wheel notch in fullscreen mode. */
const DEFAULT_WHEEL_LINES = 5;

interface ScrollSpeedSettings {
    wheelLines?: unknown;
    enabled?: unknown;
    fullscreenWheelScrollLines?: unknown;
}

function parseWheelLines(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 1
        ? value
        : undefined;
}

function readSettings(file: string): ScrollSpeedSettings | undefined {
    try {
        const settings = JSON.parse(readFileSync(file, "utf8")) as {
            scrollSpeed?: unknown;
            fullscreenWheelScrollLines?: unknown;
        };
        if (!settings || typeof settings !== "object") return undefined;
        const scrollSpeed = settings.scrollSpeed;
        return {
            ...(scrollSpeed && typeof scrollSpeed === "object"
                ? (scrollSpeed as ScrollSpeedSettings)
                : {}),
            fullscreenWheelScrollLines: settings.fullscreenWheelScrollLines,
        };
    } catch {
        return undefined;
    }
}

type ConfiguredWheelLines =
    | { state: "value"; value: number; source: string }
    | { state: "off"; source: string };
type WheelLinesOverride = number | "off" | undefined;
type BuiltInWheelLines = number | "auto";

/** Precedence: CLI flag > trusted project settings > global settings > default. */
function resolveWheelLines(pi: ExtensionAPI, ctx: ExtensionContext): ConfiguredWheelLines {
    const flag = pi.getFlag("wheel-lines");
    if (typeof flag === "string") {
        if (flag.trim().toLowerCase() === "off") {
            return { state: "off", source: "--wheel-lines flag" };
        }
        const value = parseWheelLines(Number(flag));
        if (value !== undefined) return { state: "value", value, source: "--wheel-lines flag" };
    }

    if (ctx.isProjectTrusted()) {
        const project = readSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
        if (project?.enabled === false) return { state: "off", source: "project settings" };
        const value = parseWheelLines(project?.wheelLines);
        if (value !== undefined) return { state: "value", value, source: "project settings" };
    }

    const global = readSettings(join(getAgentDir(), "settings.json"));
    if (global?.enabled === false) return { state: "off", source: "global settings" };
    const value = parseWheelLines(global?.wheelLines);
    if (value !== undefined) return { state: "value", value, source: "global settings" };
    return { state: "value", value: DEFAULT_WHEEL_LINES, source: "default" };
}

/** The supported fullscreen TUI method used to update wheel scrolling. */
interface AltScreenLike {
    setWheelScrollLines(lines: BuiltInWheelLines): void;
}

const SUGGESTED_WHEEL_LINES = [1, 2, 3, 5, 10];

export default function (pi: ExtensionAPI): void {
    pi.registerFlag("wheel-lines", {
        description: 'Lines scrolled per mouse-wheel notch in Pi fullscreen mode (number, or "off")',
        type: "string",
    });

    let configured: ConfiguredWheelLines = {
        state: "value",
        value: DEFAULT_WHEEL_LINES,
        source: "default",
    };
    let override: WheelLinesOverride;
    let activeTui: AltScreenLike | undefined;
    // Pi's own configured value, used when this extension is disabled.
    let originalWheelLines: BuiltInWheelLines = "auto";

    const currentIsOff = () =>
        override === "off" || (override === undefined && configured.state === "off");
    const currentWheelLines = () =>
        override !== undefined && override !== "off"
            ? override
            : configured.state === "value"
                ? configured.value
                : DEFAULT_WHEEL_LINES;
    const currentSource = () =>
        override !== undefined ? "runtime override (/scroll-speed)" : configured.source;
    const describeCurrent = () =>
        currentIsOff()
            ? `disabled (Pi built-in: ${originalWheelLines}; ${currentSource()})`
            : `${currentWheelLines()} line(s) per wheel notch (${currentSource()})`;

    const applyWheelLines = (): void => {
        activeTui?.setWheelScrollLines(currentIsOff() ? originalWheelLines : currentWheelLines());
    };

    pi.registerCommand("scroll-speed", {
        description: "Lines scrolled per mouse-wheel notch (fullscreen): set, off, reset, or show",
        getArgumentCompletions: (prefix) => {
            const needle = prefix.trim();
            const items: AutocompleteItem[] = [
                ...SUGGESTED_WHEEL_LINES.map((value) => ({
                    value: String(value),
                    label: String(value),
                    description: `${value} line${value === 1 ? "" : "s"} per wheel notch`,
                })),
                { value: "off", label: "off", description: "restore Pi's built-in wheel scrolling" },
                { value: "reset", label: "reset", description: "revert to flag/settings/default" },
            ];
            const filtered = items.filter((item) => item.value.startsWith(needle));
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();
            if (!arg) {
                ctx.ui.notify(
                    `Scroll speed: ${describeCurrent()}. Use /scroll-speed <N>, off, or reset.`,
                    "info",
                );
                return;
            }
            if (arg === "off") {
                override = "off";
                applyWheelLines();
                ctx.ui.notify("Scroll speed disabled for this session; Pi's built-in setting restored.", "info");
                return;
            }
            if (arg === "reset") {
                override = undefined;
                applyWheelLines();
                ctx.ui.notify(`Scroll speed restored to ${describeCurrent()}.`, "info");
                return;
            }
            const value = parseWheelLines(Number(arg));
            if (value === undefined) {
                ctx.ui.notify(`Invalid scroll speed: "${arg}". Use a positive integer, off, or reset.`, "error");
                return;
            }
            override = value;
            applyWheelLines();
            ctx.ui.notify(`Scroll speed set to ${value} line(s) per wheel notch for this session.`, "info");
        },
    });

    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        configured = resolveWheelLines(pi, ctx);
        // Respect Pi's existing fullscreenWheelScrollLines setting when "off" is used.
        const global = readSettings(join(getAgentDir(), "settings.json"));
        const project = ctx.isProjectTrusted()
            ? readSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
            : undefined;
        const builtIn = project?.fullscreenWheelScrollLines ?? global?.fullscreenWheelScrollLines;
        originalWheelLines = builtIn === "auto" ? "auto" : parseWheelLines(builtIn) ?? "auto";

        const previousFactory = ctx.ui.getEditorComponent();
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            const candidate = tui as Partial<AltScreenLike>;
            activeTui = typeof candidate.setWheelScrollLines === "function"
                ? (candidate as AltScreenLike)
                : undefined;
            applyWheelLines();
            return previousFactory
                ? previousFactory(tui, theme, keybindings)
                : new CustomEditor(tui, theme, keybindings);
        });
    });
}
