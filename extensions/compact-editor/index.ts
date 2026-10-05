// Compact editor with activity status on the border and model/thinking info on the right.
// @ts-nocheck

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

class CompactEditor extends CustomEditor {
  private uiTheme: any;
  private embeddedWorkingStatusIndicator: any;
  private model: string;

  constructor(tui: any, theme: any, keybindings: any, uiTheme: any, model = "") {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.uiTheme = uiTheme;
    this.model = model;

    // Keep the main agent's editor on the base theme border color. Pi normally
    // changes this for each thinking level; agent-specific colors can be added
    // later when subagents or multiple agents are introduced.
    const baseBorderColor = (text: string) => this.uiTheme.fg("border", text);
    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => baseBorderColor,
      set: () => {},
    });
  }

  override render(width: number): string[] {
    // Reserve one column on each side for the vertical frame.
    const innerWidth = Math.max(1, width - 2);
    const lines = super.render(innerWidth);
    const contentLineCount = (this as any).renderedVisibleLineCount ?? 1;
    const bottomBorderIndex = contentLineCount + 1;

    // Keep a little breathing room in the editor while preserving autocomplete geometry.
    if (bottomBorderIndex <= lines.length) {
      lines.splice(bottomBorderIndex, 0, " ".repeat(innerWidth));
    }

    return lines.map((line, index) => {
      if (index === 0) return this.borderColor("╭") + line + this.borderColor("╮");
      if (index === contentLineCount + 2) return this.borderColor("╰") + line + this.borderColor("╯");
      return this.borderColor("│") + line + this.borderColor("│");
    });
  }

  override handleMouse(event: any): any {
    event = { ...event, x: Math.max(0, event.x - 1) };
    const contentLineCount = (this as any).renderedVisibleLineCount ?? 1;
    const autocompleteStart = contentLineCount + 2;

    // render() inserts one row before autocomplete, so translate clicks back
    // to the coordinates expected by the base editor.
    if (event.y >= autocompleteStart + 1) {
      return super.handleMouse({ ...event, y: event.y - 1 });
    }
    return super.handleMouse(event);
  }

  override setWorkingStatusIndicator(indicator: any) {
    this.embeddedWorkingStatusIndicator = indicator;
    this.tui.requestRender();
  }

  setModel(model: string) {
    this.model = model;
    this.tui.requestRender();
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    if (width === 1) return this.borderColor("─");

    const topLeft = this.embeddedWorkingStatusIndicator
      ? this.fitBorderLabel(this.embeddedWorkingStatusIndicator.renderInBorder(width))
      : "";
    const topMiddle = hiddenLineCount > 0 ? this.fitBorderLabel(`↑ ${hiddenLineCount} more`) : "";
    const topRight = this.model ? this.uiTheme.fg("dim", ` ${this.model} `) : "";

    const middleWidth = visibleWidth(topMiddle);
    const labels = [
      { text: topLeft, start: 1 },
      { text: topMiddle, start: Math.floor((width - middleWidth) / 2) },
      { text: topRight, start: width - visibleWidth(topRight) - 1 },
    ].filter((label) => label.text);

    let cursor = 0;
    for (const label of labels) {
      if (label.start < 0 || label.start - cursor < (cursor === 0 ? 0 : 3)) {
        return super.renderTopBorder(width, hiddenLineCount);
      }
      cursor = label.start + visibleWidth(label.text);
    }
    if (cursor > width) return super.renderTopBorder(width, hiddenLineCount);

    let border = "";
    cursor = 0;
    for (const label of labels) {
      border += this.borderColor("─".repeat(label.start - cursor)) + label.text;
      cursor = label.start + visibleWidth(label.text);
    }
    return border + this.borderColor("─".repeat(width - cursor));
  }

  private fitBorderLabel(text: string): string {
    return text ? this.borderColor(` ${text} `) : "";
  }
}

export default function (pi: any) {
  let editor: CompactEditor | undefined;
  const runningTools = new Map<string, string>();

  pi.on("session_start", (_event: any, ctx: any) => {
    if (!ctx.hasUI) return;

    const model = formatModel(ctx.model, pi.getThinkingLevel());
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      editor = new CompactEditor(tui, theme, keybindings, ctx.ui.theme, model);
      return editor;
    });
  });

  pi.on("model_select", (event: any, ctx: any) => {
    if (!ctx.hasUI) return;
    editor?.setModel(formatModel(event.model, pi.getThinkingLevel()));
  });

  pi.on("thinking_level_select", (event: any, ctx: any) => {
    if (!ctx.hasUI) return;
    editor?.setModel(formatModel(ctx.model, event.level));
  });

  pi.on("agent_start", (_event: any, ctx: any) => {
    runningTools.clear();
    ctx.ui.setWorkingMessage("Working");
  });

  pi.on("turn_start", (_event: any, ctx: any) => {
    runningTools.clear();
    ctx.ui.setWorkingMessage("Working");
  });

  pi.on("message_update", (event: any, ctx: any) => {
    if (runningTools.size > 0) return;

    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        ctx.ui.setWorkingMessage("Thinking");
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
        ctx.ui.setWorkingMessage("Streaming");
        break;
      default:
        break;
    }
  });

  pi.on("tool_execution_start", (event: any, ctx: any) => {
    runningTools.set(event.toolCallId, event.toolName);
    ctx.ui.setWorkingMessage(`Running ${event.toolName}`);
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    runningTools.delete(event.toolCallId);
    if (runningTools.size === 0) {
      ctx.ui.setWorkingMessage("Working");
    } else if (runningTools.size === 1) {
      const toolName = Array.from(runningTools.values())[0];
      ctx.ui.setWorkingMessage(`Running ${toolName}`);
    } else {
      ctx.ui.setWorkingMessage(`Running ${runningTools.size} tools`);
    }
  });

  pi.on("agent_settled", () => {
    runningTools.clear();
  });

  pi.on("session_shutdown", () => {
    editor = undefined;
  });
}

function formatModel(model: { provider: string; id: string } | undefined, thinkingLevel = ""): string {
  const base = model ? `(${model.provider}) ${model.id}` : "";
  const level = thinkingLevel && thinkingLevel !== "off" ? ` • ${thinkingLevel}` : "";
  return `${base}${level}`;
}
