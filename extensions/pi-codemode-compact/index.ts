import {
    highlightCode,
    type AgentToolResult,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
    sliceByColumn,
    stripTerminalSequences,
    Text,
    visibleWidth,
} from "@earendil-works/pi-tui";

/** Minimal theme surface required by the summary builders (subset of pi-tui Theme). */
export interface ThemeLike {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

/** Render context type derived from pi's ToolDefinition contract. */
export type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** Nested tool call structure provided in result.details.calls. */
export type NestedCall = CodemodeToolDetails["calls"][number];

/** Tool usage entry aggregated from script source. */
export interface ToolUsage {
    name: string;
    count: number;
}

/**
 * Result structure accepted by renderResult.
 * Matches AgentToolResult while accommodating loose content objects (e.g. image blocks with mimeType).
 */
export interface CodemodeRenderResult {
    content?: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
    details?: CodemodeToolDetails;
    isError?: boolean;
}

/** Fallback maximum summary width (columns) when terminal width cannot be determined. */
const MAX_SUMMARY = 96;
/** Minimum summary width preserved even on very narrow terminals. */
const MIN_SUMMARY = 24;
/**
 * Maximum number of tool names listed before summarizing with '+N'.
 * Matches pi's default CALL_PREVIEW_COUNT (8) for parity.
 */
const MAX_NAMES = 8;
/**
 * Width budget reserved for title ("codemode "), delimiters, line counts, and padding.
 * Worst-case collapsed call line: title (9) + summary (max) + " · 999 lines" (12) = max + 21.
 * 24 leaves 3 columns of slack for shell margin / TUI container padding.
 */
const WIDTH_RESERVE = 24;
/** Terminal column width consumed by the result status icon and space ("✓ " / "✗ "). */
const ICON_COLUMNS = 2;

/**
 * Regex for tools.read(...) style calls.
 * Applied after stripping comments and strings to prevent false positives.
 */
const TOOL_DOT = /\btools\s*\.\s*([A-Za-z_$][\w$]*)/g;
/**
 * Regex for tools["read"](...) style calls.
 * Matched against raw code with index checking to ensure the access is not inside a string or comment.
 */
const TOOL_KEY = /\btools\s*\[\s*["']([^"']+)["']\s*\]/g;

/**
 * Strips strings, template literals, and comments in a single pass:
 * 1. Double-quoted strings: "(?:\\.|[^"\\\n])*"
 * 2. Single-quoted strings: '(?:\\.|[^'\\\n])*'
 * 3. Template literals: `(?:\\.|[^`\\])*`
 * 4. Multi-line comments: /\*[\s\S]*?\* /
 * 5. Single-line comments: //[^
]*
 * Replaced with spaces so that word boundaries (\b) are preserved.
 */
const STRINGS_AND_COMMENTS = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Regex matching pi's script execution header. */
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/;

/**
 * Strips ANSI escapes, OSC/APC/DCS sequences, control characters, carriage returns,
 * and expands tabs to 3 spaces.
 */
export function plain(text: string): string {
    return stripTerminalSequences(text)
        // 8-bit CSI escape sequences not covered by stripTerminalSequences
        .replace(/\u009b[0-9;?]*[A-Za-z]/g, "")
        // Non-printable control characters except newline and tab
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
        .replace(/\r/g, "")
        .replace(/\t/g, "   ");
}

/**
 * Middle-truncates text to fit within max columns (wide-character aware),
 * preserving head and tail with an ellipsis in between.
 * If max <= 1, returns text unmodified.
 */
export function clip(text: string, max: number): string {
    if (max <= 1 || visibleWidth(text) <= max) return text;
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${sliceByColumn(text, 0, head)}…${tail > 0 ? sliceByColumn(text, visibleWidth(text) - tail, tail) : ""}`;
}

/** Calculates usable column width for summary text based on terminal dimensions. */
export function summaryWidth(columns: number | undefined = process.stdout?.columns): number {
    if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) return MAX_SUMMARY;
    return Math.max(MIN_SUMMARY, Math.min(MAX_SUMMARY, columns - WIDTH_RESERVE));
}

/**
 * Aggregates nested tool calls from script code in order of appearance.
 * Filters out references inside comments and string literals.
 * If isRegisteredTool filter is provided, only matches recognized tool names.
 */
export function toolUsage(
    code: string,
    isRegisteredTool?: (name: string) => boolean,
): ToolUsage[] {
    const counts = new Map<string, number>();
    const add = (name: string | undefined) => {
        if (name && (!isRegisteredTool || isRegisteredTool(name))) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    };

    const noiseSpans = [...code.matchAll(STRINGS_AND_COMMENTS)].map((m) => [
        m.index ?? 0,
        (m.index ?? 0) + m[0].length,
    ]);
    const isInsideNoise = (index: number) => noiseSpans.some(([start, end]) => index >= start && index < end);

    const matches: Array<{ name: string; index: number }> = [];

    for (const match of code.matchAll(TOOL_DOT)) {
        const index = match.index ?? 0;
        if (!isInsideNoise(index)) {
            matches.push({ name: match[1], index });
        }
    }

    for (const match of code.matchAll(TOOL_KEY)) {
        const index = match.index ?? 0;
        if (!isInsideNoise(index)) {
            matches.push({ name: match[1], index });
        }
    }

    // Preserve script appearance order across both dot and bracket notations
    matches.sort((a, b) => a.index - b.index);
    for (const { name } of matches) {
        add(name);
    }

    return [...counts].map(([name, count]) => ({ name, count }));
}

/** Formats tool usage counts into a readable label (e.g. 'read×3, bash'). */
export function namesLabel(usage: ReadonlyArray<ToolUsage>): string {
    const shown = usage
        .slice(0, MAX_NAMES)
        .map(({ name, count }) => (count > 1 ? `${name}×${count}` : name))
        .join(", ");
    return usage.length > MAX_NAMES ? `${shown} +${usage.length - MAX_NAMES}` : shown;
}

/** Aggregates an array of names into counts preserving appearance order. */
export function countNames(names: readonly string[]): ToolUsage[] {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
}

/** Returns the first non-empty, non-comment line of code. */
export function firstCodeLine(code: string): string {
    for (const raw of code.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
        return line;
    }
    return "";
}

/** Returns a concise summary: tool names list if any tools are used, otherwise first code line. */
export function codeSummary(code: string, isRegisteredTool?: (name: string) => boolean): string {
    const usage = toolUsage(code, isRegisteredTool);
    return usage.length > 0 ? namesLabel(usage) : firstCodeLine(code);
}

/** Counts non-empty lines in text. */
export function countLines(text: string): number {
    return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Splits script execution header from output body and extracts wall time in seconds.
 * Handles both multi-block output and unified single-block output.
 */
export function splitScriptOutput(
    content: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>,
): { body: string; wallTime?: number } {
    const texts = content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .filter((text) => text !== "");
    const first = texts[0] ?? "";
    const header = SCRIPT_HEADER.exec(first);
    if (!header) return { body: texts.join("\n") };
    const wallTime = Number(header[1]);
    const body = [first.slice(header[0].length), ...texts.slice(1)].filter((text) => text !== "").join("\n");
    return { body, wallTime: Number.isFinite(wallTime) ? wallTime : undefined };
}

/**
 * Extracts the first non-empty error line following the last 'Script error:' marker.
 * Skips stack frame traces ('at ...') to find the actual error description.
 */
export function errorLine(body: string): string {
    const lines = plain(body)
        .split("\n")
        .map((line) => line.trim());
    // pi appends "Script error:" after output blocks, so the last marker is authoritative
    const at = lines.findLastIndex((line) => line.startsWith("Script error:"));
    if (at < 0) return lines.find(Boolean) ?? "";
    const next = lines.slice(at + 1).find((line) => line && !line.startsWith("at "));
    const inline = lines[at].slice("Script error:".length).trim();
    return next || inline;
}

/** Formats USD cost: shows 2 decimal places if >= $0.01, otherwise 2 significant digits. */
export function formatCost(cost: number): string {
    return cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2);
}

/** Calculates total USD cost from nested calls; undefined if no calls reported cost. */
export function totalCost(calls: readonly NestedCall[]): number | undefined {
    const priced = calls.filter((call) => typeof call.cost === "number" && Number.isFinite(call.cost));
    return priced.length > 0 ? priced.reduce((sum, call) => sum + (call.cost ?? 0), 0) : undefined;
}

/** Formats a single collapsed call line. */
export function callLine(
    theme: ThemeLike,
    code: string | null,
    max: number = MAX_SUMMARY,
    isRegisteredTool?: (name: string) => boolean,
): string {
    const title = theme.fg("toolTitle", theme.bold("codemode"));
    if (code === null) return `${title} ${theme.fg("error", "[invalid arg]")}`;
    const script = plain(code).trim();
    if (!script) return title;
    const lines = countLines(script);
    const summary = codeSummary(script, isRegisteredTool);
    const head = summary ? ` ${theme.fg("accent", clip(summary, max))}` : "";
    const tail = lines > 1 ? theme.fg("dim", ` · ${lines} lines`) : "";
    return `${title}${head}${tail}`;
}

/** Formats an in-progress execution line with currently running tools and total call count. */
export function runningLine(theme: ThemeLike, calls: readonly NestedCall[], max: number = MAX_SUMMARY): string {
    const active = calls.filter((call) => call.status === "running");
    const label = namesLabel(countNames((active.length > 0 ? active : calls).map((call) => call.name)));
    const head = theme.fg("warning", "…");
    if (!label) return head;
    const total = calls.length;
    const tail = total > 0 ? theme.fg("dim", ` · ${total} ${total === 1 ? "call" : "calls"}`) : "";
    return `${head} ${theme.fg("accent", clip(label, max))}${tail}`;
}

/** Formats a single collapsed result line for success or failure. */
export function resultLine(
    theme: ThemeLike,
    view: { calls: readonly NestedCall[]; body: string; wallTime?: number; truncated: boolean; failed: boolean },
    max: number = MAX_SUMMARY,
): string {
    const budget = Math.max(ICON_COLUMNS, max - ICON_COLUMNS);
    if (view.failed) {
        // ponytail: When multiple calls fail, findLast picks the latest failing call as the most likely root cause
        const failing = [...view.calls].reverse().find((call) => call.status === "error")?.name;
        const label = `${failing ? `${failing} — ` : ""}${errorLine(view.body) || "Script failed"}`;
        return theme.fg("error", `✗ ${clip(label, budget)}`);
    }
    const parts: string[] = [];
    parts.push(namesLabel(countNames(view.calls.map((call) => call.name))) || "done");
    const lines = countLines(view.body);
    if (lines > 0) parts.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
    if (view.wallTime !== undefined) parts.push(`${view.wallTime.toFixed(1)}s`);
    const cost = totalCost(view.calls);
    if (cost !== undefined) parts.push(`$${formatCost(cost)}`);
    if (view.truncated) parts.push("truncated");
    return `${theme.fg("success", "✓")} ${theme.fg("dim", clip(parts.join(" · "), budget))}`;
}

function statusIcon(status: NestedCall["status"], theme: Theme): string {
    switch (status) {
        case "running":
            return theme.fg("warning", "…");
        case "ok":
            return theme.fg("success", "✓");
        case "error":
            return theme.fg("error", "✗");
        case "cancelled":
        default:
            return theme.fg("muted", "⊘");
    }
}

/** Formats a single call detail row for expanded view. */
function callDetail(theme: Theme, call: NestedCall, max: number): string {
    const duration = call.durationMs === undefined
        ? ""
        : theme.fg("dim", ` ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`);
    const cost = call.cost !== undefined ? theme.fg("dim", ` $${formatCost(call.cost)}`) : "";
    const line = `${statusIcon(call.status, theme)} ${theme.fg("toolTitle", call.name)} ${theme.fg("muted", clip(plain(call.args), max))}${duration}${cost}`;
    if (!call.error) return line;
    const errorSummary = clip(plain(call.error).replace(/\s*\n\s*/g, " "), max);
    return `${line}\n  ${theme.fg("error", errorSummary)}`;
}

/** Reuses the previous Text component to avoid unnecessary allocations during frequent updates. */
function textComponent(lastComponent: unknown, text: string): Text {
    const component = (lastComponent as Text | undefined)?.setText ? (lastComponent as Text) : new Text("", 0, 0);
    component.setText(text);
    return component;
}

/** Retrieves currently registered tool names from pi to filter false positives. */
function registeredToolNames(pi: ExtensionAPI): Set<string> | null {
    try {
        return new Set(pi.getAllTools().map((tool) => tool.name));
    } catch {
        return null;
    }
}

export function renderCall(
    args: { code?: unknown } | undefined,
    theme: Theme,
    context: RenderContext,
    knownTools: Set<string> | null,
): Text {
    // Stream states: string = ready, null = invalid complete arg, "" = streaming in-progress
    const code = typeof args?.code === "string" ? args.code : context.argsComplete ? null : "";
    const max = summaryWidth();
    const isRegisteredTool = knownTools && knownTools.size > 0 ? (name: string) => knownTools.has(name) : undefined;
    let text = callLine(theme, code, max, isRegisteredTool);
    if (context.expanded && code) {
        const script = plain(code).trimEnd();
        let body: string;
        try {
            body = highlightCode(script, "javascript").join("\n");
        } catch {
            body = script; // Fallback if syntax highlighting fails
        }
        if (body) text += `\n${body}`;
    }
    return textComponent(context.lastComponent, text);
}

export function renderResult(
    result: CodemodeRenderResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
): Text {
    const calls = result.details?.calls ?? [];
    const max = summaryWidth();
    const { body, wallTime } = splitScriptOutput(result.content ?? []);
    const lines: string[] = options.isPartial
        ? [runningLine(theme, calls, max)]
        : [
                resultLine(theme, {
                    calls,
                    body,
                    wallTime,
                    truncated: result.details?.fullOutputPath !== undefined,
                    // pi supplies failure status via context.isError; result.isError accepted as fallback
                    failed: context.isError === true || result.isError === true,
                }, max),
            ];
    if (options.expanded) {
        for (const call of calls) lines.push(callDetail(theme, call, max));
        const fullOutputPath = result.details?.fullOutputPath;
        if (fullOutputPath) lines.push(theme.fg("muted", `Full output: ${fullOutputPath}`));
        const output = plain(body).trim();
        if (output) lines.push(output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"));
    }
    return textComponent(context.lastComponent, lines.join("\n"));
}

export default function codemodeCompact(pi: ExtensionAPI): void {
    // Resolvers run in extension load order and next() returns what the remaining resolvers, then the
    // registered tool, would draw. Returning our renderers overrides only the slots we define;
    // spreading next() preserves any other slot (renderShell) another definition supplies.
    pi.registerToolRenderer((toolName, next) =>
        toolName === "codemode"
            ? {
                    ...next(),
                    renderCall: (args: unknown, theme: Theme, context: RenderContext) =>
                        renderCall(args as { code?: unknown } | undefined, theme, context, registeredToolNames(pi)),
                    renderResult: (result, options, theme, context) =>
                        renderResult(result as unknown as CodemodeRenderResult, options, theme, context),
                }
            : next());
}
