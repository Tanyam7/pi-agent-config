import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Wire-level protocol for a subagent checkpoint. Checkpoints deliberately use
 * a different event type and sidecar files from completion, so a saved state
 * can never be mistaken for a finished subagent.
 */
export const SUBAGENT_PROTOCOL = "pi-subagent-checkpoint" as const;
export const SUBAGENT_PROTOCOL_VERSION = 1 as const;

export type SubagentProtocolEventType = "checkpoint_request" | "final_result";

interface ProtocolEventBase {
  protocol: typeof SUBAGENT_PROTOCOL;
  version: typeof SUBAGENT_PROTOCOL_VERSION;
  type: SubagentProtocolEventType;
  runId: string;
  name: string;
  emittedAt: string;
}

export interface CheckpointRequestEvent extends ProtocolEventBase {
  type: "checkpoint_request";
  checkpointId: string;
  /** Durable progress/state supplied by the child; this is not a final result. */
  state: string;
  /** Optional question or direction requested from the parent. */
  request?: string;
}

export interface FinalResultEvent extends ProtocolEventBase {
  type: "final_result";
  outcome: "completed" | "failed";
  summary: string;
  exitCode: number;
  agent?: string;
  task?: string;
  elapsed?: number;
  sessionId?: string;
  errorMessage?: string;
}

export type SubagentProtocolEvent = CheckpointRequestEvent | FinalResultEvent;

export function checkpointRequestPath(sessionFile: string): string {
  return `${sessionFile}.checkpoint-request`;
}

export function createCheckpointRequest(params: {
  runId: string;
  name: string;
  checkpointId: string;
  state: string;
  request?: string;
  emittedAt?: string;
}): CheckpointRequestEvent {
  return {
    protocol: SUBAGENT_PROTOCOL,
    version: SUBAGENT_PROTOCOL_VERSION,
    type: "checkpoint_request",
    runId: params.runId,
    name: params.name,
    checkpointId: params.checkpointId,
    state: params.state,
    ...(params.request ? { request: params.request } : {}),
    emittedAt: params.emittedAt ?? new Date().toISOString(),
  };
}

export function createFinalResult(params: {
  runId: string;
  name: string;
  outcome: "completed" | "failed";
  summary: string;
  exitCode: number;
  agent?: string;
  task?: string;
  elapsed?: number;
  sessionId?: string;
  errorMessage?: string;
  emittedAt?: string;
}): FinalResultEvent {
  return {
    protocol: SUBAGENT_PROTOCOL,
    version: SUBAGENT_PROTOCOL_VERSION,
    type: "final_result",
    runId: params.runId,
    name: params.name,
    outcome: params.outcome,
    summary: params.summary,
    exitCode: params.exitCode,
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.task ? { task: params.task } : {}),
    ...(params.elapsed != null ? { elapsed: params.elapsed } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
    emittedAt: params.emittedAt ?? new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasBase(value: unknown, type: SubagentProtocolEventType): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.protocol === SUBAGENT_PROTOCOL &&
    value.version === SUBAGENT_PROTOCOL_VERSION &&
    value.type === type &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.emittedAt === "string" &&
    value.emittedAt.length > 0
  );
}

export function isCheckpointRequest(value: unknown): value is CheckpointRequestEvent {
  return (
    hasBase(value, "checkpoint_request") &&
    typeof value.checkpointId === "string" &&
    value.checkpointId.length > 0 &&
    typeof value.state === "string" &&
    (value.request == null || typeof value.request === "string")
  );
}

export function isFinalResult(value: unknown): value is FinalResultEvent {
  return (
    hasBase(value, "final_result") &&
    (value.outcome === "completed" || value.outcome === "failed") &&
    typeof value.summary === "string" &&
    Number.isInteger(value.exitCode) &&
    (value.agent == null || typeof value.agent === "string") &&
    (value.task == null || typeof value.task === "string") &&
    (value.elapsed == null || Number.isFinite(value.elapsed)) &&
    (value.sessionId == null || typeof value.sessionId === "string") &&
    (value.errorMessage == null || typeof value.errorMessage === "string")
  );
}

export function isSubagentProtocolEvent(value: unknown): value is SubagentProtocolEvent {
  return isCheckpointRequest(value) || isFinalResult(value);
}

/** Write one protocol event atomically so a watcher never reads partial JSON. */
export function writeProtocolEvent(path: string, event: SubagentProtocolEvent): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${event.type}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(event)}\n`, "utf8");
  try {
    renameSync(tempPath, path);
  } catch (error) {
    // Windows does not replace an existing target with renameSync. Protocol
    // Writers are single-owner, so removing an old protocol event is safe.
    try {
      unlinkSync(path);
    } catch {
      // The target may not exist.
    }
    renameSync(tempPath, path);
    void error;
  }
}

export function readProtocolEvent(path: string): SubagentProtocolEvent | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isSubagentProtocolEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Consume an event only when it has the expected type and (optionally) id. */
export function consumeProtocolEvent<T extends SubagentProtocolEventType>(
  path: string,
  type: T,
  id?: string,
): Extract<SubagentProtocolEvent, { type: T }> | null {
  const event = readProtocolEvent(path);
  if (!event || event.type !== type) return null;
  if (id != null && event.type === "checkpoint_request" && event.checkpointId !== id) {
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    // A concurrent cleanup is harmless; the event has already been read.
  }
  return event as Extract<SubagentProtocolEvent, { type: T }>;
}
