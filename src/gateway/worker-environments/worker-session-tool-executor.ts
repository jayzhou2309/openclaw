import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import { PresenceQueryParamsSchema } from "../../../packages/gateway-protocol/src/schema/presence.js";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import {
  bindAgentToolExecutionLocation,
  copyAgentToolMetadata,
} from "../../agents/agent-tool-metadata.js";
import {
  buildBlockedToolResult,
  runBeforeToolCallHook,
} from "../../agents/agent-tools.before-tool-call.js";
import { runAgentHarnessAfterToolCallHook } from "../../agents/harness/hook-helpers.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  type AgentToolGatewayRequestCaller,
  type InProcessGatewayCaller,
  runWithGatewayToolCleanupContext,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { SessionPortalToolSchema } from "../../agents/tools/portal-tool-contract.js";
import { createAvailablePortalTools } from "../../agents/tools/portal-tool.js";
import { capturePresenceToolAuthority } from "../../agents/tools/presence-tool-authority.js";
import { PRESENCE_QUERY_TIMEOUT_MS } from "../../agents/tools/presence-tool-contract.js";
import { createPresenceTool } from "../../agents/tools/presence-tool.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
} from "../../agents/tools/sessions-placement-tool-contract.js";
import type { PlacedSessionsSpawnArguments } from "../../agents/tools/sessions-placement-tool-contract.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { WORKER_TOOL_NAMES } from "../../worker/tool-authority.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerPortalToolExecutor,
  type WorkerPortalToolExecutorDependencies,
} from "./worker-portal-tool-executor.js";
import {
  executeWorkerSessionToolWithReplay,
  serializeWorkerSessionToolResult as serializeResult,
  workerSessionToolErrorResult as errorResult,
  WorkerSessionToolOutcomeUnknownError,
  type WorkerSessionToolExecutor,
  type WorkerSessionToolRequest,
  parseWorkerSessionToolResult,
} from "./worker-session-tool-result.js";
import { executeWorkerSessionSend } from "./worker-session-tool-send.js";
import {
  assertWorkerSessionToolChild as assertExactChild,
  readWorkerSessionToolEntry,
  resolveWorkerSessionToolSource as exactSource,
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  workerSessionRelationKey as relationKey,
  type WorkerSessionToolSource as ExactSource,
} from "./worker-session-tool-topology.js";

function toolArguments(request: WorkerSessionToolRequest): Record<string, unknown> {
  if (request.toolName === "skill_workshop") return request.request.arguments;
  const { toolCallId: _toolCallId, ...args } = request.request;
  return args;
}

function prepareRequest(
  binding: Pick<WorkerSessionToolRequest, "identity" | "signal" | "onUpdate">,
  toolName: string,
  toolCallId: string,
  raw: unknown,
): WorkerSessionToolRequest | undefined {
  if (toolName === "sessions_spawn" && Value.Check(PlacedSessionsSpawnSchema, raw))
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  if (toolName === "sessions_send" && Value.Check(PlacedSessionsSendSchema, raw))
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  if (toolName === "portal" && Value.Check(SessionPortalToolSchema, raw)) {
    if (
      (raw.title?.length ?? 0) > 256 ||
      (raw.description?.length ?? 0) > 8 * 1024 ||
      (raw.path?.length ?? 0) > 1024 ||
      (raw.id?.length ?? 0) > 256
    )
      return undefined;
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "presence" && Value.Check(PresenceQueryParamsSchema, raw))
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  if (toolName === "skill_workshop" && Value.Check(SkillLibraryWorkshopSchema, raw))
    return { ...binding, toolName, request: { arguments: raw, toolCallId } };
  return undefined;
}

async function applyToolPolicy(
  request: WorkerSessionToolRequest,
  source: ExactSource,
): Promise<
  { request: WorkerSessionToolRequest } | { result: ReturnType<typeof buildBlockedToolResult> }
> {
  const toolCallId = request.request.toolCallId;
  const runId = request.identity.runId ?? undefined;
  const outcome = await runBeforeToolCallHook({
    toolName: request.toolName,
    params: toolArguments(request),
    toolCallId,
    ctx: {
      agentId: source.agentId,
      config: getRuntimeConfig(),
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      runId,
    },
    signal: request.signal,
    approvalMode: "deny",
  });
  if (outcome.blocked) {
    return {
      result: buildBlockedToolResult({
        reason: outcome.reason,
        deniedReason: outcome.deniedReason,
        toolCallId,
        runId,
      }),
    };
  }
  const adjusted = prepareRequest(request, request.toolName, toolCallId, outcome.params);
  return adjusted
    ? { request: adjusted }
    : {
        result: buildBlockedToolResult({
          reason: `Tool call blocked because before_tool_call returned invalid ${request.toolName} input.`,
          toolCallId,
          runId,
        }),
      };
}

type WorkerSessionToolAuthority = {
  assertSource: () => void;
  collectExecutionIdentity: boolean;
  callGateway: <T = Record<string, unknown>>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
    sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
  ) => Promise<T>;
};

function computeRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

function operationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

function childSessionKey(operationSeed: string, targetAgentId: string): string {
  return `agent:${targetAgentId}:dashboard:cloud-${sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${operationSeed}\0child-session`,
    32,
  )}`;
}

type WorkerGatewayToolsDependencies = {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
  portals: WorkerPortalToolExecutorDependencies["portals"];
  skillWorkshop?: AnyAgentTool;
};

export function createWorkerSessionToolExecutor(
  params: WorkerGatewayToolsDependencies,
): WorkerSessionToolExecutor {
  const inFlight = new Map<string, Promise<string>>();
  const executePortal = createWorkerPortalToolExecutor(params);

  const runWithSource = async (
    operation: { source: ExactSource; request: WorkerSessionToolRequest },
    run: (
      authority: WorkerSessionToolAuthority,
      request: WorkerSessionToolRequest,
    ) => Promise<AgentToolResult<unknown>>,
  ): Promise<AgentToolResult<unknown>> => {
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    return await runWithScopedSessionAccess({
      cfg: getRuntimeConfig(),
      agentId: operation.source.agentId,
      storePath: capability.sessionTarget.storePath,
      expectedSessionId: operation.source.sessionId,
      targetSessionKey: operation.source.sessionKey,
      ...(operation.request.signal ? { signal: operation.request.signal } : {}),
      run: () =>
        capability.run((owner) =>
          withGatewayToolCallerIdentity(
            {
              agentId: owner.agentId,
              sessionKey: owner.sessionKey,
              gatewayContextResolver: params.resolveGatewayContext,
              operationalRunInstance: owner.operationalRunInstance,
              approvalAuthority: owner.delegatedAuthority,
              ...(owner.operatorAuthority ? { operatorAuthority: owner.operatorAuthority } : {}),
              executionIdentityToken: owner.executionIdentityToken,
              receiptAuthority: owner.receiptAuthority,
              workerTurnClaim: owner.turnClaim,
              workerTurnExecutionIdentityCapability: capability,
              ...(operation.request.signal ? { approvalSignals: [operation.request.signal] } : {}),
            },
            async () => {
              const assertPresenceSourceCurrent =
                operation.request.toolName === "presence"
                  ? (owner.assertPresenceSourceCurrent ?? capturePresenceToolAuthority())
                  : undefined;
              const assertSource = () => {
                operation.request.signal?.throwIfAborted();
                owner.receiptAuthority();
                assertPresenceSourceCurrent?.();
                const source = operation.source;
                if (
                  assertPresenceSourceCurrent &&
                  !params.placements.isWorkerTurnToolAuthorized(source.turnClaim, "presence")
                ) {
                  throw new Error("Worker session tool authority changed");
                }
                if (source.agentId !== owner.agentId || source.sessionKey !== owner.sessionKey) {
                  throw new Error("Worker source turn owner changed");
                }
              };
              const callGateway = async <R = Record<string, unknown>>(
                request: Parameters<AgentToolGatewayRequestCaller>[0],
                sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
              ): Promise<R> => {
                assertSource();
                return await capability.run(() =>
                  callAgentToolGatewayRequest<R>(
                    withAgentToolGatewayRuntimeIdentity(
                      {
                        ...request,
                        ...(operation.request.signal ? { signal: operation.request.signal } : {}),
                      },
                      {
                        kind: "agentRuntime",
                        agentId: owner.agentId,
                        sessionKey: owner.sessionKey,
                        operationalRunInstance: owner.operationalRunInstance,
                        delegatedAuthority: {
                          kind: "worker",
                          ...owner.delegatedAuthority,
                          turnClaim: owner.turnClaim,
                        },
                        ...(owner.executionIdentityToken
                          ? { executionIdentity: owner.executionIdentityToken }
                          : {}),
                        ...(sessionSpawnContext ? { sessionSpawnContext } : {}),
                      },
                    ),
                  ),
                );
              };
              assertSource();
              const startedAt = Date.now();
              let request = operation.request;
              let result: AgentToolResult<unknown> | undefined;
              let errorMessage: string | undefined;
              try {
                const policy = await applyToolPolicy(request, operation.source);
                assertSource();
                if (
                  !params.placements.isWorkerTurnToolAuthorized(
                    operation.source.turnClaim,
                    request.toolName,
                  )
                ) {
                  throw new Error("Worker session tool authority changed");
                }
                if ("result" in policy) result = policy.result;
                else {
                  request = policy.request;
                  result = await run(
                    {
                      assertSource,
                      callGateway,
                      collectExecutionIdentity: owner.executionIdentityToken !== undefined,
                    },
                    request,
                  );
                }
                return result;
              } catch (error) {
                errorMessage = errorResult(error).details.error;
                throw error;
              } finally {
                void runAgentHarnessAfterToolCallHook({
                  toolName: request.toolName,
                  toolCallId: request.request.toolCallId,
                  runId: request.identity.runId ?? undefined,
                  agentId: owner.agentId,
                  sessionKey: owner.sessionKey,
                  sessionId: operation.source.sessionId,
                  startArgs: toolArguments(request),
                  result,
                  error: errorMessage,
                  startedAt,
                });
              }
            },
          ),
        ),
    });
  };

  const spawn = async (
    operation: {
      source: ExactSource;
      identity: WorkerConnectionIdentity;
      request: PlacedSessionsSpawnArguments & { toolCallId: string };
      operationSeed: string;
      childSessionKey: string;
      signal?: AbortSignal;
    },
    { assertSource, callGateway, collectExecutionIdentity }: WorkerSessionToolAuthority,
  ) => {
    const sourceEnvironment = params.environments.get(operation.identity.environmentId);
    if (
      !sourceEnvironment ||
      sourceEnvironment.state !== "attached" ||
      sourceEnvironment.ownerEpoch !== operation.identity.ownerEpoch ||
      !isDeepStrictEqual(sourceEnvironment.attachedSessionIds, [operation.source.sessionId])
    ) {
      throw new Error("Worker source environment changed before child spawn");
    }
    const targetAgentId = normalizeAgentId(operation.request.agentId ?? operation.source.agentId);
    const authorizedTools = WORKER_TOOL_NAMES.filter((name) =>
      params.placements.isWorkerTurnToolAuthorized(operation.source.turnClaim, name),
    );
    const gatewayCall: InProcessGatewayCaller = async <T = Record<string, unknown>>(
      method: string,
      requestParams: Record<string, unknown>,
    ): Promise<T> => {
      if (method !== "sessions.create") {
        // Cleanup settles the already-created child even after its source closes.
        return await runWithGatewayToolCleanupContext(
          () => callAgentToolGatewayRequest<T>({ method, params: requestParams, timeoutMs: null }),
          params.resolveGatewayContext,
        );
      }
      assertSource();
      let loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
      let createResponse: Record<string, unknown>;
      let creationAttempted = false;
      if (loaded.entry?.sessionId) {
        const parent =
          relationKey(loaded.entry.parentSessionKey) ?? relationKey(loaded.entry.spawnedBy);
        const parentSessionId = relationKey(loaded.entry.parentSessionId);
        if (
          loaded.canonicalKey !== operation.childSessionKey ||
          parent !== operation.source.sessionKey ||
          parentSessionId !== operation.source.sessionId
        ) {
          throw new Error("Cloud child idempotency key is already owned by another session");
        }
        createResponse = {
          ok: true,
          key: loaded.canonicalKey,
          sessionId: loaded.entry.sessionId,
          entry: loaded.entry,
        };
      } else {
        const { source } = operation;
        const createParams: Record<string, unknown> = {
          ...requestParams,
          ...(source.entry.permissionMode ? { permissionMode: source.entry.permissionMode } : {}),
          key: operation.childSessionKey,
        };
        delete createParams.task;
        creationAttempted = true;
        try {
          createResponse = await callInProcessGatewayToolWithCreation(
            "sessions.create",
            createParams,
            {
              via: "spawn",
              actor: { type: "agent", id: source.agentId },
              requesterSessionKey: source.sessionKey,
              inheritedToolPolicy: { version: 1, allow: authorizedTools, deny: [] },
            },
            {
              resolveGatewayContext: params.resolveGatewayContext,
              sessionMutationCommitGuard: assertSource,
              ...(operation.signal ? { signal: operation.signal } : {}),
              timeoutMs: null,
            },
          );
        } catch (error) {
          loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
          if (!loaded.entry?.sessionId) {
            throw error;
          }
          createResponse = {
            ok: true,
            key: loaded.canonicalKey,
            sessionId: loaded.entry.sessionId,
            entry: loaded.entry,
          };
        }
        loaded = await readWorkerSessionToolEntry(operation.childSessionKey, targetAgentId);
      }
      const childSessionId = loaded.entry?.sessionId;
      if (!childSessionId) {
        const error = new Error("Cloud child session creation did not persist an incarnation");
        throw creationAttempted ? new WorkerSessionToolOutcomeUnknownError(error) : error;
      }
      const assertChild = () =>
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
          storePath: loaded.storePath,
        });
      try {
        await assertChild();
      } catch (error) {
        if (creationAttempted) {
          throw new WorkerSessionToolOutcomeUnknownError(error);
        }
        throw error;
      }
      try {
        const config = getRuntimeConfig();
        return await runWithScopedSessionAccess({
          cfg: config,
          agentId: targetAgentId,
          storePath: loaded.storePath,
          expectedSessionId: childSessionId,
          targetSessionKey: operation.childSessionKey,
          ...(operation.signal ? { signal: operation.signal } : {}),
          run: async () => {
            await assertChild();
            const assertActiveChildPlacement = () => {
              const placement = params.placements.get(childSessionId);
              if (
                placement?.state !== "active" ||
                placement.sessionKey !== operation.childSessionKey
              ) {
                throw new Error("Cloud child placement did not become active");
              }
              const environment = params.environments.get(placement.environmentId);
              if (
                environment?.state !== "attached" ||
                environment.ownerEpoch !== placement.activeOwnerEpoch ||
                environment.attachedSessionIds.length !== 1 ||
                environment.attachedSessionIds[0] !== childSessionId ||
                environment.profileId !== sourceEnvironment.profileId ||
                environment.providerId !== sourceEnvironment.providerId ||
                !isDeepStrictEqual(environment.profileSnapshot, sourceEnvironment.profileSnapshot)
              ) {
                throw new Error("Cloud child placement does not match its parent profile");
              }
            };
            const childPlacement = params.placements.get(childSessionId);
            assertSource();
            if (childPlacement?.state !== "active") {
              try {
                await params.dispatchChild(
                  {
                    sessionId: childSessionId,
                    sessionKey: operation.childSessionKey,
                    agentId: targetAgentId,
                    profileId: sourceEnvironment.profileId,
                    executionMode: "worker-turn",
                    inheritedProfile: {
                      providerId: sourceEnvironment.providerId,
                      profileSnapshot: sourceEnvironment.profileSnapshot,
                    },
                  },
                  undefined,
                  assertSource,
                );
              } catch (error) {
                try {
                  assertActiveChildPlacement();
                } catch {
                  throw new WorkerSessionToolOutcomeUnknownError(error);
                }
              }
            }
            assertActiveChildPlacement();
            assertSource();
            await assertChild();
            const childRunId = operationKey(operation.operationSeed, "initial-task");
            const sessionSpawnContext = collectExecutionIdentity
              ? buildSubagentExecutionSessionSpawnContext({
                  enabled: true,
                  backend: "subagent",
                  parentAgentId: operation.source.agentId,
                  requesterRef: operation.source.sessionKey,
                  controllerRef: operation.source.sessionKey,
                  depth: (operation.source.entry.spawnDepth ?? 0) + 1,
                  maxDepth:
                    config.agents?.defaults?.subagents?.maxSpawnDepth ??
                    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
                  targetAgentId,
                  sandbox: "inherit",
                  inheritedToolAllowlist: authorizedTools,
                  inheritedToolDenylist: [],
                })
              : undefined;
            const run = await executeWorkerSessionToolWithReplay(async () => {
              assertSource();
              await assertChild();
              assertSource();
              assertActiveChildPlacement();
              return callGateway(
                {
                  method: "agent",
                  agentRunTracking: "native_subagent",
                  params: {
                    sessionKey: operation.childSessionKey,
                    sessionId: childSessionId,
                    expectedExistingSessionId: childSessionId,
                    message: operation.request.task,
                    deliver: false,
                    sessionEffects: "visible",
                    idempotencyKey: `worker-session-spawn:${childRunId}`,
                  },
                  ...(operation.signal ? { signal: operation.signal } : {}),
                  timeoutMs: null,
                },
                sessionSpawnContext,
              );
            });
            const runId = typeof run.runId === "string" ? run.runId : undefined;
            return {
              ...createResponse,
              ...run,
              runStarted: Boolean(runId),
              ...(runId ? { runId } : {}),
            } as T;
          },
        });
      } catch (error) {
        throw error instanceof WorkerSessionToolOutcomeUnknownError
          ? error
          : new WorkerSessionToolOutcomeUnknownError(error);
      }
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: operation.source.sessionKey,
      requesterTurnRunId: operation.identity.runId ?? undefined,
      requesterAgentIdOverride: operation.source.agentId,
      inheritedToolAllowlist: authorizedTools,
      inheritedToolDenylist: [],
      callGateway: gatewayCall,
      expectedParentSessionId: operation.source.sessionId,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    const { toolCallId, ...args } = operation.request;
    return await tool.execute(toolCallId, {
      ...args,
      expectsCompletionMessage: false,
      visible: true,
      worktree: true,
    });
  };

  return async (request) => {
    const source = await exactSource({ identity: request.identity, placements: params.placements });
    if (request.toolName === "portal" || request.toolName === "skill_workshop") {
      return await runWithSource({ source, request }, async (authority, prepared) => {
        if (prepared.toolName === "portal")
          return executePortal(prepared, source, authority.assertSource);
        if (prepared.toolName === "skill_workshop" && params.skillWorkshop)
          return params.skillWorkshop.execute(
            prepared.request.toolCallId,
            prepared.request.arguments,
            prepared.signal,
            prepared.onUpdate,
          );
        throw new Error("Worker tool policy changed the tool identity");
      });
    }
    if (request.toolName === "presence") {
      return await runWithSource({ source, request }, async (authority, prepared) => {
        const tool = createPresenceTool({
          assertSourceCurrent: authority.assertSource,
          callGateway: authority.callGateway,
        });
        return tool.execute(prepared.request.toolCallId, toolArguments(prepared), prepared.signal);
      });
    }
    const requestDigest = computeRequestDigest(
      request.toolName === "sessions_spawn"
        ? {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            task: request.request.task,
            label: request.request.label ?? null,
            agentId: request.request.agentId ?? null,
            model: request.request.model ?? null,
            runTimeoutSeconds: request.request.runTimeoutSeconds ?? null,
          }
        : {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            sessionKey: request.request.sessionKey,
            message: request.request.message,
            timeoutSeconds: request.request.timeoutSeconds ?? null,
          },
    );
    const started = await params.placements.beginWorkerSessionToolOperation(
      {
        claim: source.turnClaim,
        toolName: request.toolName,
        toolCallId: request.request.toolCallId,
        requestDigest,
      },
      () => {
        request.signal?.throwIfAborted();
        if (!params.placements.isWorkerTurnToolAuthorized(source.turnClaim, request.toolName)) {
          throw new Error("Worker session tool authority changed");
        }
      },
    );
    if (started.kind === "completed") {
      return parseWorkerSessionToolResult(started.resultJson);
    }
    if (started.kind === "unknown")
      return errorResult(new Error("The prior operation outcome is unknown; it was not replayed"));
    if (started.kind === "conflict")
      return errorResult(new Error("Worker tool call id was reused"));
    if (started.kind === "capacity")
      return errorResult(new Error("Too many worker session operations are already in progress"));
    if (started.kind === "unauthorized") {
      throw new Error("Worker session tool authority changed");
    }
    const sourceClaimId = source.turnClaim.claimId;
    const operationIdentity = {
      sourceSessionId: source.sessionId,
      sourceClaimId,
      toolCallId: request.request.toolCallId,
      requestDigest,
    };
    const inFlightKey = `${source.sessionId}\0${sourceClaimId}\0${request.request.toolCallId}`;
    if (started.kind === "in-progress") {
      const existing = inFlight.get(inFlightKey);
      return existing
        ? parseWorkerSessionToolResult(await existing)
        : errorResult(new Error("Worker session operation is already in progress"));
    }
    const completeOperation = async (result: unknown, failed = false) => {
      const resultJson = serializeResult(result);
      return (await params.placements.completeWorkerSessionToolOperation({
        ...operationIdentity,
        resultJson,
        failed,
      }))
        ? resultJson
        : serializeResult(errorResult(new Error("Worker session operation lost ownership")));
    };
    const operation = (async () => {
      let result: unknown;
      let failed = false;
      try {
        // Only the elected durable owner runs policy; retries reuse its terminal result.
        result = await runWithSource({ source, request }, async (authority, prepared) => {
          if (prepared.toolName !== "sessions_spawn" && prepared.toolName !== "sessions_send") {
            throw new Error("Worker tool policy changed the tool identity");
          }
          if (prepared.toolName === "sessions_spawn") {
            const targetAgentId = normalizeAgentId(prepared.request.agentId ?? source.agentId);
            const childKey = childSessionKey(started.operationSeed, targetAgentId);
            if (
              !(await params.placements.bindWorkerSessionToolOperationChild({
                ...operationIdentity,
                childSessionKey: childKey,
              }))
            ) {
              throw new Error("Worker child spawn operation changed before execution");
            }
            return await spawn(
              {
                source,
                identity: prepared.identity,
                request: prepared.request,
                operationSeed: started.operationSeed,
                childSessionKey: childKey,
                signal: prepared.signal,
              },
              authority,
            );
          }
          return await executeWorkerSessionSend({
            assertSource: authority.assertSource,
            callGateway: authority.callGateway,
            source,
            target: await exactAuthorizedTarget({
              source,
              requestedSessionKey: prepared.request.sessionKey,
            }),
            request: prepared.request,
            idempotencyKey: `worker-session-send:${operationKey(started.operationSeed, "target-send")}`,
            signal: prepared.signal,
          });
        });
      } catch (error) {
        if (error instanceof WorkerSessionToolOutcomeUnknownError || request.signal?.aborted) {
          if (!(await params.placements.abandonWorkerSessionToolOperation(operationIdentity))) {
            return serializeResult(
              errorResult(new Error("Worker session operation lost ownership")),
            );
          }
          return serializeResult(
            errorResult(
              error instanceof WorkerSessionToolOutcomeUnknownError
                ? error
                : new Error("Worker session operation outcome is unknown after cancellation"),
            ),
          );
        }
        failed = true;
        result = errorResult(error);
      }
      return completeOperation(result, failed);
    })();
    inFlight.set(inFlightKey, operation);
    try {
      return parseWorkerSessionToolResult(await operation);
    } finally {
      if (inFlight.get(inFlightKey) === operation) {
        inFlight.delete(inFlightKey);
      }
    }
  };
}

export function createWorkerWorkshopCallRetention() {
  const calls = new Map<string, { digest: string; result: ReturnType<AnyAgentTool["execute"]> }>();
  return (
    toolCallId: string,
    args: unknown,
    execute: () => ReturnType<AnyAgentTool["execute"]>,
  ) => {
    const digest = JSON.stringify(args);
    const prior = calls.get(toolCallId);
    if (prior && prior.digest !== digest) {
      throw new Error("Workshop tool call id was reused with different arguments.");
    }
    if (!prior && calls.size >= 64) {
      throw new Error("This turn reached its Workshop operation limit. Continue in a fresh turn.");
    }
    const result = prior?.result ?? execute();
    calls.set(toolCallId, { digest, result });
    return result;
  };
}

export function createWorkerGatewayTools(
  params: WorkerGatewayToolsDependencies & { identity: WorkerConnectionIdentity },
): AnyAgentTool[] {
  const claim = params.identity.turnClaim;
  if (!claim) throw new Error("Worker source turn has no operational owner");
  const capability = getWorkerTurnExecutionIdentityCapability(params.placements, claim);
  if (!capability) throw new Error("Worker source turn has no operational owner");
  const source = capability.sessionTarget;
  const execute = createWorkerSessionToolExecutor(params);
  const toolOptions = { agentSessionKey: source.sessionKey, workerPlacement: true };
  const portal = createAvailablePortalTools({
    sessionPortalTarget: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      environmentId: params.identity.environmentId,
      assertCurrent: capability.receiptAuthority,
    },
  })[0]!;
  const tools = [
    createSessionsSpawnTool(toolOptions),
    createSessionsSendTool(toolOptions),
    portal,
    createPresenceTool(),
    ...(params.skillWorkshop ? [params.skillWorkshop] : []),
  ];
  const retainWorkshopCall = createWorkerWorkshopCallRetention();
  const bound = tools.map(
    (tool): AnyAgentTool => ({
      ...tool,
      execute: async (toolCallId, raw, signal, onUpdate) => {
        const assertAuthorized = () => {
          capability.receiptAuthority();
          if (!params.placements.isWorkerTurnToolAuthorized(claim, tool.name)) {
            throw new Error("Worker session tool authority changed");
          }
        };
        assertAuthorized();
        const binding = { identity: params.identity, signal, onUpdate };
        const operation = prepareRequest(binding, tool.name, toolCallId, raw);
        if (!operation) {
          throw new Error(`Invalid ${tool.name} arguments`);
        }
        const result =
          tool.name === "skill_workshop"
            ? retainWorkshopCall(toolCallId, raw, () => execute(operation))
            : execute(operation);
        const value = await result;
        assertAuthorized();
        return value;
      },
    }),
  );
  bound.forEach((tool, index) => {
    copyAgentToolMetadata(tools[index]!, tool);
    bindAgentToolExecutionLocation(tool, {
      kind: "gateway",
      replay: tool.name === "sessions_spawn" || tool.name === "sessions_send",
      ...(tool.name === "presence"
        ? { connectionScoped: true, timeout: { minimumMs: PRESENCE_QUERY_TIMEOUT_MS } }
        : tool.name === "sessions_spawn"
          ? { timeout: { minimumMs: 900_000 } }
          : tool.name === "sessions_send"
            ? { timeout: { argument: "timeoutSeconds", defaultSeconds: 30, paddingMs: 60_000 } }
            : {}),
    });
  });
  return bound;
}
