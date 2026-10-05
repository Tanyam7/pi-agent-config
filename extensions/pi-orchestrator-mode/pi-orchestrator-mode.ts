import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_WORKFLOW_GROUP, WorkflowMutex, type WorkflowMutexOwner } from "../plan-mode/workflow-mutex.js";

const MAIN_POLICY = `
## Main Pi orchestrator policy

You are the root Pi orchestrator.

- Clearly distinguish observed facts, recommendations, and unverified assumptions in your responses.
- Prefer parallel execution for independent tasks; keep dependent or conflicting work sequential.
- Choose the most cost-effective capable agent for each task: use scout primarily for read-only local inspection and finding things, researcher primarily for research and read work that clarifies requirements, reviewer for critique, and worker specifically for implementation once requirements are clear (workers may read as needed, but implementation is their main role). Escalate capability only when the task requires it.
- Give every subagent a detailed handoff with: objective, relevant context, exact starting points (files, symbols, commands, or URLs), scope and exclusions, constraints, dependencies, expected deliverables, and an explicit stopping point/done criterion.
- When collecting results, state which handoffs are complete, which are still running, and what remains blocked or unverified.

## Orchestrator-only execution

- Do not read, write, edit, inspect, execute commands, or perform the user's task yourself.
- Your only job is to orchestrate subagents and summarize their outputs.
- Delegate every task to subagents. When there is nothing to do, wait for subagents to complete or wait for user input.
- Do not claim work was done unless a subagent reported it.
`;

const ORCHESTRATOR_TOOLS = ["subagent", "subagent_message", "subagents_list"] as const;
const ORCHESTRATOR_STATUS_KEY = "orchestrator-mode";
const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-orchestrator-mode", "config.json");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ModelTarget = { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
type OrchestratorConfig = { orchestratorModel: ModelTarget };

function parseModelTarget(value: unknown, name: string): ModelTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const target = value as Record<string, unknown>;
  if (typeof target.provider !== "string" || !target.provider.trim()) throw new Error(`${name}.provider must be a non-empty string`);
  if (typeof target.modelId !== "string" || !target.modelId.trim()) throw new Error(`${name}.modelId must be a non-empty string`);
  if (!THINKING_LEVELS.includes(target.thinkingLevel as ThinkingLevel)) {
    throw new Error(`${name}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return {
    provider: target.provider.trim(),
    modelId: target.modelId.trim(),
    thinkingLevel: target.thinkingLevel as ThinkingLevel,
  };
}

function loadConfig(): OrchestratorConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Missing config file: ${CONFIG_PATH}`);
    throw new Error(`Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config root must be an object");
  const config = value as Record<string, unknown>;
  return { orchestratorModel: parseModelTarget(config.orchestratorModel, "orchestratorModel") };
}

function isSubagentProcess(): boolean {
  return Boolean(process.env.PI_SUBAGENT_ID);
}

export default function piOrchestratorMode(pi: ExtensionAPI) {
  if (isSubagentProcess()) return;

  const workflowMutex = new WorkflowMutex(pi);
  let workflowOwner: WorkflowMutexOwner | undefined;
  let session: object | undefined;
  let active = false;
  let previousActiveTools: string[] | undefined;
  let activeConfig: OrchestratorConfig | undefined;
  let previousModel: ExtensionContext["model"];
  let previousThinkingLevel: ThinkingLevel | undefined;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(ORCHESTRATOR_STATUS_KEY, active ? "Orchestrator mode" : undefined);
  };

  const bindSession = (ctx: ExtensionContext) => {
    if (session === ctx.sessionManager) return;
    if (active) {
      workflowMutex.release(workflowOwner, AGENT_WORKFLOW_GROUP);
      workflowOwner = undefined;
      active = false;
      previousActiveTools = undefined;
      activeConfig = undefined;
      previousModel = undefined;
      previousThinkingLevel = undefined;
    }
    session = ctx.sessionManager;
    workflowMutex.bindSession(session);
    updateStatus(ctx);
  };

  const applyModelTarget = async (target: ModelTarget, ctx: ExtensionContext, label: string): Promise<boolean> => {
    const model = ctx.modelRegistry.find(target.provider, target.modelId);
    if (!model) {
      notify(ctx, `${label} model ${target.provider}/${target.modelId} is unavailable. Check ${CONFIG_PATH}.`, "error");
      return false;
    }
    try {
      if (!(await pi.setModel(model))) {
        notify(ctx, `Could not select ${label} model ${target.provider}/${target.modelId}; check its authentication.`, "error");
        return false;
      }
      pi.setThinkingLevel(target.thinkingLevel);
      return true;
    } catch {
      notify(ctx, `Could not apply ${label} model ${target.provider}/${target.modelId}.`, "error");
      return false;
    }
  };

  const enter = async (ctx: ExtensionContext) => {
    if (active) {
      notify(ctx, "Orchestrator mode is already active.");
      return;
    }
    bindSession(ctx);
    if (!ctx.isIdle()) {
      notify(ctx, "Cannot start Orchestrator mode while an agent run is active. Wait for it to settle, then retry.", "warning");
      return;
    }
    const missing = ORCHESTRATOR_TOOLS.filter((name) => !pi.getActiveTools().includes(name));
    if (missing.length > 0) {
      notify(ctx, `Cannot start Orchestrator mode because these subagent tools are unavailable: ${missing.join(", ")}.`, "error");
      return;
    }
    let config: OrchestratorConfig;
    try {
      config = loadConfig();
    } catch (error) {
      notify(ctx, `${error instanceof Error ? error.message : String(error)} (config: ${CONFIG_PATH}) Orchestrator mode was not changed.`, "error");
      return;
    }
    const owner = workflowMutex.acquire(AGENT_WORKFLOW_GROUP);
    if (!owner) {
      notify(ctx, "Cannot start Orchestrator mode because another workflow, such as Plan mode, is active.", "warning");
      return;
    }
    const modelBefore = ctx.model;
    const thinkingLevelBefore = pi.getThinkingLevel();
    if (!(await applyModelTarget(config.orchestratorModel, ctx, "Orchestrator"))) {
      workflowMutex.release(owner, AGENT_WORKFLOW_GROUP);
      return;
    }
    previousModel = modelBefore;
    previousThinkingLevel = thinkingLevelBefore;
    previousActiveTools = pi.getActiveTools();
    workflowOwner = owner;
    activeConfig = config;
    active = true;
    pi.setActiveTools([...ORCHESTRATOR_TOOLS]);
    updateStatus(ctx);
    notify(ctx, `Orchestrator mode enabled with ${config.orchestratorModel.modelId}:${config.orchestratorModel.thinkingLevel}. I will only delegate to subagents and summarize their outputs.`);
  };

  const exit = async (ctx: ExtensionContext) => {
    if (!active) {
      notify(ctx, "Orchestrator mode is not active.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      notify(ctx, "Cannot leave Orchestrator mode while an agent run is active. Wait for it to settle, then retry.", "warning");
      return;
    }
    let previousStateRestored = false;
    if (previousModel) {
      try {
        previousStateRestored = await pi.setModel(previousModel);
        if (previousStateRestored && previousThinkingLevel) pi.setThinkingLevel(previousThinkingLevel);
      } catch {
        previousStateRestored = false;
      }
    }
    if (previousActiveTools) pi.setActiveTools(previousActiveTools);
    previousActiveTools = undefined;
    previousModel = undefined;
    previousThinkingLevel = undefined;
    activeConfig = undefined;
    active = false;
    workflowMutex.release(workflowOwner, AGENT_WORKFLOW_GROUP);
    workflowOwner = undefined;
    updateStatus(ctx);
    notify(ctx, `Orchestrator mode disabled${previousStateRestored ? "; previous model and thinking level restored" : "; could not restore the previous model"}.`);
  };

  pi.registerCommand("orch", {
    description: "Enter or leave Orchestrator mode",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "off" || command === "exit") await exit(ctx);
      else if (command === "on" || command === "start") await enter(ctx);
      else if (!command) {
        if (active) await exit(ctx);
        else await enter(ctx);
      } else notify(ctx, "Usage: /orch [on|off|exit]", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    bindSession(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (active) workflowMutex.release(workflowOwner, AGENT_WORKFLOW_GROUP);
    active = false;
    workflowOwner = undefined;
    previousActiveTools = undefined;
    activeConfig = undefined;
    previousModel = undefined;
    previousThinkingLevel = undefined;
    updateStatus(ctx);
    session = undefined;
  });

  pi.on("before_agent_start", (event) => {
    if (!active) return;
    event.systemPromptOptions.sections.orchestrator_policy = MAIN_POLICY;
  });

  pi.on("tool_call", (event) => {
    if (!active) return;
    if ((ORCHESTRATOR_TOOLS as readonly string[]).includes(event.toolName)) return;
    return {
      block: true,
      terminate: true,
      reason: `Orchestrator mode only permits subagent tools. Delegate this work instead of calling '${event.toolName}'.`,
    };
  });
}
