/** Real isolated Gateway: A2A steps keep their system prompt stable across turns and handoffs. */
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../config/config.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  startTestGatewayServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await waitForGatewayActiveWork(30_000);
    for (const root of tempDirs.dirs) {
      await releaseGatewaySessionStoreFixture(root);
    }
    cleanup();
  }),
);
let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
beforeAll(async () => {
  const module = await import("./server-kernel.js");
  const create = module.createGatewayKernel;
  const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await create(...args);
    return kernel;
  });
  try {
    server = await startTestGatewayServer(await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }));
  } finally {
    capture.mockRestore();
  }
});
afterAll(async () => {
  await server.close();
});

it("keeps A2A step system prompts byte-stable and sends turn facts with the current turn", async () => {
  const requester = "agent:main:main";
  const target = "agent:main:dashboard:a2a-peer";
  testState.sessionStorePath = path.join(tempDirs.make("openclaw-a2a-cache-"), "sessions.json");
  await writeSessionStore({
    entries: {
      [requester]: { sessionId: "a2a-requester", updatedAt: Date.now() },
      [target]: { sessionId: "a2a-target", updatedAt: Date.now() },
    },
  });
  await prepareGatewayReplyRuntimeForTest();

  const steps: AgentCommandGatewayIngressOpts[] = [];
  agentCommandMock.mockImplementation(async (opts) => {
    const command = opts as AgentCommandGatewayIngressOpts;
    steps.push(command);
    await command.userTurnTranscriptRecorder?.persistApproved();
    const text = command.extraSystemPrompt?.includes("Agent-to-agent reply step")
      ? "ack"
      : command.extraSystemPrompt?.includes("Agent-to-agent announce step")
        ? "ANNOUNCE_SKIP"
        : "peer response";
    const sessionId = command.sessionId ?? "a2a-target";
    const routing = {
      runId: command.runId ?? sessionId,
      sessionKey: command.sessionKey,
      sessionId,
      agentId: command.agentId,
      lifecycleGeneration: command.lifecycleGeneration,
    };
    const startedAt = Date.now();
    emitAgentEvent({ ...routing, stream: "lifecycle", data: { phase: "start", startedAt } });
    await persistSessionTranscriptTurn(
      { sessionId, sessionKey: command.sessionKey, storePath: testState.sessionStorePath },
      {
        cwd: "/tmp",
        updateMode: "none",
        messages: [
          { message: { role: "assistant", content: [{ type: "text", text }] }, now: Date.now() },
        ],
      },
    );
    emitAgentEvent({
      ...routing,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: Date.now(),
        terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
      },
    });
    return { payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1 } };
  });
  const announceSteps = () =>
    steps.filter((step) => step.extraSystemPrompt?.includes("Agent-to-agent announce step"));

  for (const [index, message] of ["first request", "second request"].entries()) {
    const tool = createSessionsSendTool({
      agentSessionKey: requester,
      config: { ...getRuntimeConfig(), tools: { sessions: { visibility: "all" } } },
    });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: requester,
        operationalRunInstance: createOperationalRunInstanceRef(`a2a-cache-${index}`),
        receiptAuthority: () => true,
        gatewayContextResolver: () => kernel.gatewayRequestContext,
      },
      () => tool.execute(`a2a-cache-${index}`, { sessionKey: target, message, timeoutSeconds: 5 }),
    );
    await vi.waitFor(() => expect(announceSteps()).toHaveLength(index + 1), { timeout: 20_000 });
  }

  const requesterReplySteps = steps.filter(
    (step) =>
      step.sessionKey === requester &&
      step.extraSystemPrompt?.includes("Agent-to-agent reply step"),
  );
  expect(requesterReplySteps.map((step) => step.runtimeContextFragments)).toEqual(
    [1, 3, 5, 1, 3, 5].map((turn) => [
      { kind: "runtime-instruction", text: `Agent-to-agent reply turn ${turn} of 5.` },
    ]),
  );
  expect(new Set(requesterReplySteps.map((step) => step.extraSystemPrompt)).size).toBe(1);

  const [firstAnnounce, secondAnnounce] = announceSteps();
  expect(secondAnnounce?.extraSystemPrompt).toBe(firstAnnounce?.extraSystemPrompt);
  expect(firstAnnounce?.message).toContain("Original request: first request");
  expect(secondAnnounce?.message).toContain("Original request: second request");
  expect(secondAnnounce?.message).toContain("Latest reply: ack");
}, 60_000);
