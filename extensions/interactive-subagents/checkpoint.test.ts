import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointRequestPath,
  consumeProtocolEvent,
  createCheckpointRequest,
  createFinalResult,
  isCheckpointRequest,
  isFinalResult,
  isSubagentProtocolEvent,
  writeProtocolEvent,
} from "./checkpoint.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagent checkpoint protocol", () => {
  test("keeps notification-only checkpoint_request distinct from final_result", () => {
    const request = createCheckpointRequest({
      runId: "run-1",
      name: "worker",
      checkpointId: "cp-1",
      state: "half done",
      request: "Continue after the parent responds",
      emittedAt: "2026-09-29T00:00:00.000Z",
    });
    const result = createFinalResult({
      runId: "run-1",
      name: "worker",
      outcome: "completed",
      summary: "All files updated",
      exitCode: 0,
      emittedAt: "2026-09-29T00:00:02.000Z",
    });

    expect(request.type).toBe("checkpoint_request");
    expect(result.type).toBe("final_result");
    expect(isCheckpointRequest(request)).toBe(true);
    expect(isFinalResult(result)).toBe(true);
    expect(isSubagentProtocolEvent(request)).toBe(true);
    expect(isSubagentProtocolEvent(result)).toBe(true);
    expect(request.type).not.toBe(result.type);
  });

  test("consumes a checkpoint notification immediately without a reply sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-test-"));
    tempDirs.push(dir);
    const sessionFile = join(dir, "child.jsonl");
    const requestPath = checkpointRequestPath(sessionFile);
    const replyPath = `${sessionFile}.checkpoint-reply`;
    const request = createCheckpointRequest({
      runId: "run-2",
      name: "worker",
      checkpointId: "cp-2",
      state: "in progress",
      emittedAt: "2026-09-29T00:00:00.000Z",
    });

    // The child writes one notification sidecar and can continue as soon as
    // this synchronous write returns. There is deliberately no reply path in
    // the protocol, and consuming the notification does not wait for one.
    expect(writeProtocolEvent(requestPath, request)).toBeUndefined();
    expect(JSON.parse(readFileSync(requestPath, "utf8")).type).toBe("checkpoint_request");
    expect(existsSync(replyPath)).toBe(false);

    expect(consumeProtocolEvent(requestPath, "checkpoint_request")?.checkpointId).toBe("cp-2");
    expect(existsSync(requestPath)).toBe(false);
    expect(existsSync(replyPath)).toBe(false);
  });

  test("rejects a checkpoint notification as final_result", () => {
    expect(
      isFinalResult({
        protocol: "pi-subagent-checkpoint",
        version: 1,
        type: "checkpoint_request",
        runId: "run-3",
        name: "worker",
        checkpointId: "cp-3",
        state: "not complete",
        emittedAt: "2026-09-29T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});
