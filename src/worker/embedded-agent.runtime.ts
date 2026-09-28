import type { SkillResourceDelivery } from "../../packages/gateway-protocol/src/schema/skill-resources.js";
import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { finalizeAgentToolAvailability } from "../agents/agent-tool-availability.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { copyAgentToolMetadata } from "../agents/agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import { projectMemoryFlushTools } from "../agents/agent-tools.memory-flush.js";
import { buildBootstrapContextForFiles } from "../agents/bootstrap-files.js";
import { createEmbeddedAgentResourceLoader } from "../agents/embedded-agent-runner/resource-loader.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/embedded-agent-runner/run/setup.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { resolveToolLoopDetectionConfig } from "../agents/tool-loop-detection-config.js";
import { wrapToolWithGatewayCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type { AssistantMessage, AssistantMessageEventStreamLike } from "../llm/types.js";
import { materializeSkillResources } from "../skills/runtime/resources.js";
import { createWorkerBrowserToolRuntime, type WorkerBrowserRuntime } from "./browser-runtime.js";
import { createWorkerComputerTool } from "./computer-runtime.js";
import { createWorkerLiveRuntime, type WorkerLiveClient } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toWorkerInferenceContext,
  type WorkerTranscriptClient,
} from "./embedded-agent-transcript.runtime.js";
import type { WorkerBrowserLaunchDescriptor, WorkerLaunchPlan } from "./launch-descriptor.js";
import type { WorkerToolAuthority, WorkerToolName } from "./tool-authority.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { createWorkerGatewayTools } from "./worker-gateway-tools.js";
import { createWorkerPlacementTools, WORKER_TOOL_CONFIG } from "./worker-placement-tools.js";

function toWorkerAgentError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

type WorkerEmbeddedInferenceRequest = {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
  signal?: AbortSignal;
};

type WorkerEmbeddedInferenceClient = {
  stream: (
    request: WorkerEmbeddedInferenceRequest,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>;
};

type RunWorkerEmbeddedTurnParams = {
  skillResources?: SkillResourceDelivery;
  agentId: string;
  operationalRunInstance: OperationalRunInstanceRef;
  agentRuntimeIdentityToken: string;
  cwd: string;
  workerContainmentRoot: string;
  stateDir: string;
  github?: PreparedGitHubToolEnvironment;
  sessionId: string;
  sessionKey: string;
  runId: string;
  prompt: WorkerLaunchPlan["assignment"]["prompt"];
  modelRef: WorkerInferenceModelRef;
  inference: WorkerEmbeddedInferenceClient;
  transcript: WorkerTranscriptClient;
  live: WorkerLiveClient;
  gatewayTools: Parameters<typeof createWorkerGatewayTools>[1];
  toolSurface: WorkerToolSurface;
  bootstrapFiles: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>;
  initialMessages?: WorkerTranscriptMessage[];
  suppressPromptTranscript?: boolean;
  systemPrompt?: string;
  inferenceOptions?: WorkerInferenceOptions;
  allowedToolNames: readonly WorkerToolName[];
  permissionMode?: import("../../packages/gateway-protocol/src/schema/sessions-row.js").SessionPermissionMode;
  execAuthority: WorkerToolAuthority["exec"];
  browser?: WorkerBrowserLaunchDescriptor;
  browserRuntime?: WorkerBrowserRuntime;
  computer?: Omit<Parameters<typeof createWorkerComputerTool>[0], "runId" | "registerRunCleanup">;
  signal?: AbortSignal;
};

export async function runWorkerEmbeddedTurn(params: RunWorkerEmbeddedTurnParams): Promise<void> {
  const resources = params.skillResources
    ? await materializeSkillResources(params.skillResources, () => params.signal?.throwIfAborted())
    : undefined;
  try {
    await runWorkerEmbeddedTurnWithResources(
      {
        ...params,
        prompt: resources
          ? typeof params.prompt === "string"
            ? resources.rewriteReferences(params.prompt)
            : params.prompt.map((part) =>
                part.type === "text"
                  ? { ...part, text: resources.rewriteReferences(part.text) }
                  : part,
              )
          : params.prompt,
        systemPrompt:
          [params.systemPrompt, resources?.snapshot.prompt].filter(Boolean).join("\n\n") ||
          undefined,
      },
      resources?.snapshot,
    );
  } finally {
    await resources?.cleanup();
  }
}

async function runWorkerEmbeddedTurnWithResources(
  params: RunWorkerEmbeddedTurnParams,
  skillsSnapshot?: import("../skills/types.js").SkillSnapshot,
): Promise<void> {
  const browserAuthorized = params.allowedToolNames.includes("browser");
  if (browserAuthorized !== (params.browser !== undefined)) {
    throw new Error("Worker Browser authority and launch descriptor must be provided together.");
  }
  if (params.allowedToolNames.includes("computer") !== (params.computer !== undefined)) {
    throw new Error("Worker computer authority and launch descriptor must be provided together.");
  }
  if (params.operationalRunInstance.runId !== params.runId) {
    throw new Error("worker operational run instance disagrees with the admitted turn");
  }
  const toolSurface = params.toolSurface;
  const model = createNativeModelOwnedRuntimeModel({
    provider: params.modelRef.provider,
    modelId: params.modelRef.model,
  });
  model.contextWindow = toolSurface.policy.modelContextWindowTokens ?? model.contextWindow;
  if (toolSurface.policy.modelHasVision !== undefined) {
    model.input = toolSurface.policy.modelHasVision ? ["text", "image"] : ["text"];
  }
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const contextFiles = buildBootstrapContextForFiles(params.bootstrapFiles, {});
  const resourceLoader = createEmbeddedAgentResourceLoader({
    cwd: params.cwd,
    agentDir: params.stateDir,
    settingsManager,
    // The Gateway supplies literal text, not a local prompt-file path.
    appendSystemPromptTransform: () =>
      params.systemPrompt === undefined ? [] : [params.systemPrompt],
    agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
  });
  await resourceLoader.reload();

  const baseSessionManager = SessionManager.inMemory(params.cwd);
  for (const message of params.initialMessages ?? []) {
    baseSessionManager.appendMessage(structuredClone(message));
  }

  const transcriptRuntime = createWorkerTranscriptRuntime(params.transcript, params.signal);
  const sessionManager = guardSessionManager(baseSessionManager, {
    suppressNextUserMessagePersistence: params.suppressPromptTranscript,
    onMessagePersisted: transcriptRuntime.onMessagePersisted,
  });

  const allowedToolNameSet = new Set<string>(params.allowedToolNames);
  for (const entry of toolSurface.tools) {
    if (!allowedToolNameSet.has(entry.definition.name)) {
      throw new Error(`Worker tool surface exceeds launch authority: ${entry.definition.name}`);
    }
  }
  const activeToolNames = toolSurface.tools.map((entry) => entry.definition.name);
  const coreTools = projectMemoryFlushTools(
    createWorkerPlacementTools({
      policy: toolSurface.policy,
      cwd: params.cwd,
      containmentRoot: params.workerContainmentRoot,
      execAuthority: params.execAuthority,
      permissionMode: params.permissionMode,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      github: params.github,
      skillsSnapshot,
    }),
    toolSurface.policy.memoryFlushWritePath
      ? {
          root: params.workerContainmentRoot,
          relativePath: toolSurface.policy.memoryFlushWritePath,
        }
      : undefined,
  );
  const browserRuntime =
    params.browser && activeToolNames.includes("browser")
      ? await createWorkerBrowserToolRuntime({
          descriptor: params.browser,
          sessionKey: params.sessionKey,
          stateDir: params.stateDir,
          workspaceDir: params.cwd,
          ...(params.browserRuntime ? { runtime: params.browserRuntime } : {}),
        })
      : undefined;
  const turnLifetime = new AbortController();
  const toolSignal = params.signal
    ? AbortSignal.any([params.signal, turnLifetime.signal])
    : turnLifetime.signal;
  let computerCleanup: ((reason: string) => Promise<void>) | undefined;
  function disposeTools(failure: Error): Promise<Error>;
  function disposeTools(failure?: Error): Promise<Error | undefined>;
  async function disposeTools(failure?: Error): Promise<Error | undefined> {
    turnLifetime.abort();
    const cleanup = computerCleanup;
    computerCleanup = undefined;
    const failures = failure ? [failure] : [];
    for (const dispose of [
      () => cleanup?.("Worker turn finished"),
      () => browserRuntime?.dispose(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        const cleanupFailure = toWorkerAgentError(error, "Worker tool cleanup failed.");
        recordModelFallbackStop(cleanupFailure);
        failures.push(cleanupFailure);
      }
    }
    return failures.length > 1 ? new AggregateError(failures, "Worker turn failed") : failures[0];
  }
  const { session } = await (async () => {
    try {
      const computerTool =
        params.computer && activeToolNames.includes("computer")
          ? createWorkerComputerTool({
              ...params.computer,
              runId: params.runId,
              registerRunCleanup: (cleanup) => {
                computerCleanup = cleanup;
              },
            })
          : undefined;
      const localTools = new Map(
        [
          ...coreTools,
          ...(browserRuntime ? [browserRuntime.tool] : []),
          ...(computerTool ? [computerTool] : []),
        ].map((tool) => [tool.name, tool]),
      );
      const gatewayTools = new Map(
        createWorkerGatewayTools(toolSurface, params.gatewayTools).map((tool) => [tool.name, tool]),
      );
      const tools = toolSurface.tools.map((entry) => {
        if (entry.execution === "gateway") {
          return wrapToolWithAbortSignal(gatewayTools.get(entry.definition.name)!, toolSignal);
        }
        const source = localTools.get(entry.definition.name);
        if (!source) {
          throw new Error(`Worker placement tool unavailable: ${entry.definition.name}`);
        }
        const tool = copyAgentToolMetadata(source, { ...source, ...entry.definition });
        return wrapToolWithGatewayCallerIdentity(
          wrapToolWithAbortSignal(
            wrapToolWithBeforeToolCallHook(tool, {
              agentId: params.agentId,
              config: WORKER_TOOL_CONFIG,
              cwd: params.cwd,
              workspaceDir: params.cwd,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              requester: { senderIsOwner: true },
              loopDetection: resolveToolLoopDetectionConfig({
                cfg: WORKER_TOOL_CONFIG,
                agentId: params.agentId,
              }),
            }),
            toolSignal,
          ),
          {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            operationalRunInstance: params.operationalRunInstance,
            signedAgentRuntimeIdentityToken: params.agentRuntimeIdentityToken,
          },
        );
      });

      finalizeAgentToolAvailability(tools);
      return await createAgentSession({
        cwd: params.cwd,
        agentDir: params.stateDir,
        authStorage,
        modelRegistry,
        model,
        thinkingLevel: "medium",
        tools: [...activeToolNames],
        customTools: toToolDefinitions(tools),
        noTools: "all",
        sessionManager,
        settingsManager,
        resourceLoader,
        withSessionWriteSettlement: transcriptRuntime.withSessionWriteSettlement,
      });
    } catch (error) {
      throw await disposeTools(toWorkerAgentError(error, "Worker agent setup failed."));
    }
  })();
  session.agent.sessionId = params.sessionId;
  session.setActiveToolsByName([...activeToolNames]);
  session.agent.streamFn = (_model, context, options) => {
    const projected = toWorkerInferenceContext(context);
    if (projected.kind === "provider-replay-unavailable") {
      throw new Error(
        `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (${projected.details.reason})`,
      );
    }
    return params.inference.stream({
      modelRef: params.modelRef,
      context: projected.context,
      options: structuredClone(params.inferenceOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  };

  const liveRuntime = createWorkerLiveRuntime(params.live);
  const unsubscribe = session.subscribe(liveRuntime.handleSessionEvent);

  const abortTurn = () => session.agent.abort();
  params.signal?.addEventListener("abort", abortTurn, { once: true });

  let runFailure: Error | undefined;
  try {
    if (params.signal?.aborted) {
      throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
    }
    await session.agent.prompt({
      role: "user",
      content:
        typeof params.prompt === "string" ? [{ type: "text", text: params.prompt }] : params.prompt,
      timestamp: Date.now(),
    });
    await session.agent.waitForIdle();
    if (params.signal?.aborted) {
      throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
    }
    const terminalAssistant = session.agent.state.messages
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (terminalAssistant?.stopReason === "error") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference failed.");
    }
    if (terminalAssistant?.stopReason === "aborted") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference was aborted.");
    }
  } catch (error) {
    runFailure = params.signal?.aborted
      ? toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.")
      : toWorkerAgentError(error, "Worker agent turn failed.");
  }

  let finalTranscriptFailure: Error | undefined;
  try {
    // Provider executions must close while the Gateway still admits this turn.
    // The terminal ACK fences every later desktop RPC, including cleanup.
    runFailure = await disposeTools(runFailure);
    if (runFailure) {
      liveRuntime.enqueueRunFailure({
        aborted: params.signal?.aborted === true,
        error: runFailure,
      });
    }
    try {
      await transcriptRuntime.withSessionWriteSettlement(() => undefined);
    } catch (error) {
      finalTranscriptFailure = toWorkerAgentError(error, "Worker transcript flush failed.");
    }
    if (finalTranscriptFailure === undefined) {
      await liveRuntime.emitTerminal();
    }
  } finally {
    // Tools and prepared calls belong to this turn; promoted processes belong
    // to the enclosing environment and remain reachable through fresh tools.
    turnLifetime.abort();
    params.signal?.removeEventListener("abort", abortTurn);
    unsubscribe();
    session.dispose();
  }
  if (runFailure !== undefined) {
    throw runFailure;
  }
  if (finalTranscriptFailure !== undefined) {
    throw finalTranscriptFailure;
  }
}
