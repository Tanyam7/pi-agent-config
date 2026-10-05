// Configurable multi-line footer with token usage and extension statuses.
// Based on pi-compact-tui's pi-compact-footer.
// @ts-nocheck

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type FooterConfig, type FooterElement, getStatusKey, loadConfig } from "./config";

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(
  totals: UsageTotals,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } },
): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  if (relativeToHome === "") return "~";

  const segments = relativeToHome.split(sep);
  const directorySegments = segments
    .slice(0, -1)
    .map((segment) => (segment.startsWith(".") ? segment.slice(0, 2) : segment.slice(0, 1)));
  return ["~", ...directorySegments, segments.at(-1)].join(sep);
}

interface TokenStats extends UsageTotals {
  latestCacheHitRate: number | undefined;
}

function collectTokenStats(ctx: ExtensionContext): TokenStats {
  const usageTotals = createUsageTotals();
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsageToTotals(usageTotals, entry.message.usage);
      const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsageToTotals(usageTotals, entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsageToTotals(usageTotals, entry.usage);
    }
  }
  return { ...usageTotals, latestCacheHitRate };
}

class ConfigurableFooter implements Component {
  private ctx: ExtensionContext;
  private footerData: ReadonlyFooterDataProvider;
  private theme: Theme;
  private config: FooterConfig;
  private autoCompactEnabled = true;
  private getThinkingLevel: () => string;
  private positionedStatusKeys: Set<string>;

  constructor(opts: {
    ctx: ExtensionContext;
    footerData: ReadonlyFooterDataProvider;
    theme: Theme;
    config: FooterConfig;
    getThinkingLevel: () => string;
  }) {
    this.ctx = opts.ctx;
    this.footerData = opts.footerData;
    this.theme = opts.theme;
    this.config = opts.config;
    this.getThinkingLevel = opts.getThinkingLevel;
    this.positionedStatusKeys = new Set(
      this.config.lines
        .flatMap((line) => [...(line.left ?? []), ...(line.right ?? [])])
        .flatMap((element) => {
          if (typeof element !== "string") return [];
          const key = getStatusKey(element);
          return key === undefined ? [] : [key];
        }),
    );
  }

  setAutoCompactEnabled(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
  }

  invalidate(): void {}

  dispose(): void {
    // Git watcher cleanup is handled by the provider.
  }

  private buildAll(extensionStatuses: ReadonlyMap<string, string>): Record<string, string> {
    const stats = collectTokenStats(this.ctx);
    const state = this.ctx;
    const theme = this.theme;

    const cwd = state.sessionManager.getCwd();
    const pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
    const branch = this.footerData.getGitBranch();
    const sessionName = state.sessionManager.getSessionName();

    const contextUsage = state.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
    const contextPercentValue = contextUsage?.percent ?? 0;
    const contextTokens = contextUsage?.tokens;
    const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
    const contextDisplay =
      contextTokens != null
        ? `${formatTokens(contextTokens)}/${formatTokens(contextWindow)}${autoIndicator}`
        : `?/${formatTokens(contextWindow)}${autoIndicator}`;
    let contextStr: string;
    if (contextPercentValue > 90) contextStr = theme.fg("error", contextDisplay);
    else if (contextPercentValue > 70) contextStr = theme.fg("warning", contextDisplay);
    else contextStr = theme.fg("dim", contextDisplay);

    const usingSubscription = state.model
      ? state.model.provider === "kimi-coding" || state.modelRegistry.isUsingOAuth(state.model)
      : false;
    const costStr =
      stats.cost || usingSubscription ? `$${stats.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}` : "";

    const providerCount = this.footerData.getAvailableProviderCount();
    const providerStr = state.model && providerCount > 1 ? `(${state.model.provider})` : "";
    const modelStr = state.model?.id ?? "no-model";
    let thinkingLevelText = "";
    if (state.model?.reasoning) {
      const level = this.getThinkingLevel() || "off";
      thinkingLevelText = level === "off" ? "• thinking off" : `• ${level}`;
    }

    let statusText = "";
    if (extensionStatuses.size > 0) {
      statusText = Array.from(extensionStatuses.entries())
        .filter(([key]) => !this.positionedStatusKeys.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text))
        .join(" ");
    }

    return {
      pwd: theme.fg("dim", pwd),
      branch: branch ? theme.fg("dim", `(${branch})`) : "",
      sessionName: sessionName ? theme.fg("dim", `• ${sessionName}`) : "",
      inputTokens: stats.input ? theme.fg("dim", `↑${formatTokens(stats.input)}`) : "",
      outputTokens: stats.output ? theme.fg("dim", `↓${formatTokens(stats.output)}`) : "",
      cacheReadTokens: stats.cacheRead ? theme.fg("dim", `R${formatTokens(stats.cacheRead)}`) : "",
      cacheWriteTokens: stats.cacheWrite ? theme.fg("dim", `W${formatTokens(stats.cacheWrite)}`) : "",
      cacheHitRate:
        (stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined
          ? theme.fg("dim", `CH${stats.latestCacheHitRate.toFixed(1)}%`)
          : "",
      cost: costStr ? theme.fg("dim", costStr) : "",
      context: contextStr,
      provider: providerStr ? theme.fg("dim", providerStr) : "",
      model: modelStr ? theme.fg("dim", modelStr) : "",
      thinkingLevel: thinkingLevelText ? theme.fg("dim", thinkingLevelText) : "",
      extensionStatuses: statusText,
    };
  }

  render(width: number): string[] {
    const extensionStatuses = this.footerData.getExtensionStatuses();
    const built = this.buildAll(extensionStatuses);
    const separator = this.config.separator;

    const resolveElement = (element: FooterElement): string => {
      if (typeof element !== "string") {
        const color = element.color as ThemeColor;
        try {
          this.theme.getFgAnsi(color);
          return this.theme.fg(color, element.value);
        } catch {
          return this.theme.fg("dim", element.value);
        }
      }
      const statusKey = getStatusKey(element);
      if (statusKey !== undefined) return sanitizeStatusText(extensionStatuses.get(statusKey) ?? "");
      return built[element] ?? "";
    };

    const lines: string[] = [];
    for (const line of this.config.lines) {
      const leftParts = (line.left ?? []).map(resolveElement).filter((text) => text.length > 0);
      const rightParts = (line.right ?? []).map(resolveElement).filter((text) => text.length > 0);
      const left = leftParts.join(separator);
      const right = rightParts.join(separator);
      if (!left && !right) continue;
      lines.push(this.composeLine(left, right, width));
    }
    return lines;
  }

  private composeLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (!right) return truncateToWidth(left, width, this.theme.fg("dim", "..."));
    if (!left) {
      if (rightWidth >= width) return truncateToWidth(right, width, "");
      return " ".repeat(width - rightWidth) + right;
    }
    const minPadding = 2;
    if (leftWidth + minPadding + rightWidth <= width) {
      return left + " ".repeat(width - leftWidth - rightWidth) + right;
    }
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(right, availableForRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      return left + " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth)) + truncatedRight;
    }
    return truncateToWidth(left, width, this.theme.fg("dim", "..."));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    const config = loadConfig();
    ctx.ui.setFooter((_tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      return new ConfigurableFooter({
        ctx,
        footerData,
        theme,
        config,
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter(undefined);
  });
}
