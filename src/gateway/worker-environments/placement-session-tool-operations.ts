import { Value } from "typebox/value";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { createPlacementSessionToolOperationKernel } from "./placement-session-tool-operations.kernel.js";
import {
  PlacementSessionToolReceiptSchema,
  type PlacementSessionToolReceipt,
  type PlacementSessionToolWorkerOperations,
} from "./placement-session-tool-operations.worker-contract.js";
import {
  isPlacementTurnToolAuthorized,
  stagePlacementTurnToolWorkerPublication,
} from "./placement-turn-authority.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";

export { MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS } from "./placement-session-tool-operations.kernel.js";
type Kernel = ReturnType<typeof createPlacementSessionToolOperationKernel>;
type Waiter = (error?: Error) => void;
type Waiting = { path: string; listeners: Set<Waiter>; error?: Error };
const waiters = resolveGlobalMap<string, Waiting>(
  Symbol.for("openclaw.workerSessionToolOperationWaiters"),
  (registered) => {
    const error = new Error("Gateway lifecycle ended while waiting for worker session operations");
    for (const { listeners } of registered.values()) {
      for (const listener of listeners) listener(error);
    }
    registered.clear();
  },
);
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") return;
  for (const [id, waiting] of waiters) {
    if (waiting.path !== (event.identity?.canonicalPath ?? event.path)) continue;
    waiters.delete(id);
    const error = new Error("Worker session operation database owner retired");
    waiting.error = error;
    for (const listener of waiting.listeners) listener(error);
  }
});
function isReceipt(value: unknown): value is PlacementSessionToolReceipt {
  return Value.Check(PlacementSessionToolReceiptSchema, value);
}

export function createPlacementSessionToolOperationOps(runtime: {
  path: string;
  instanceId: string;
  now?: () => number;
}) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });
  const key = (sessionId: string, claimId: string) =>
    `${context.admission.identity.key}\0${sessionId}\0${claimId}`;
  const signal = (sessionId: string, claimId: string, error?: Error) => {
    const id = key(sessionId, claimId);
    const waiting: Waiting = waiters.get(id) ?? {
      path: context.admission.identity.canonicalPath,
      listeners: new Set<Waiter>(),
    };
    if (error) {
      waiting.error = error;
      waiters.set(id, waiting);
    } else if (!waiting.error) waiters.delete(id);
    for (const listener of waiting.listeners) listener(waiting.error);
  };
  async function execute(
    command: SqliteWorkerCommand<PlacementSessionToolWorkerOperations>,
    assertCurrent?: () => void,
    admissionFence?: ReturnType<typeof stagePlacementTurnToolWorkerPublication>,
  ): Promise<PlacementSessionToolReceipt> {
    command = structuredClone(command);
    const mutation = createPlacementWorkerMutation({
      context,
      label: "Worker session operation",
      nativeLocation: runtime.path,
      assertCurrent,
      readReceipt: (facts) => (isReceipt(facts) ? facts : undefined),
      stageCommit(facts) {
        if (!isReceipt(facts)) throw new Error("Worker session operation commit has no receipt");
        if (facts.toolNames === undefined) return undefined;
        if (
          command.type !== "placementTools.authorize" &&
          command.type !== "placementTools.seal" &&
          command.type !== "placementTools.clear"
        )
          throw new Error("Worker session receipt has unexpected tool authority");
        return stagePlacementTurnToolWorkerPublication(context.admission.identity, {
          claim: command.input.args[0],
          toolNames: facts.toolNames,
        });
      },
      publish(receipt) {
        if (
          receipt.changed &&
          (command.type === "placementTools.complete" || command.type === "placementTools.abandon")
        ) {
          const operation = command.input.args[0];
          signal(operation.sourceSessionId, operation.sourceClaimId);
        }
      },
      recoverUnknown(error, publication) {
        publication?.invalidate();
        try {
          context.admission.assertCurrent();
        } catch {
          throw error;
        }
        // Never retry uncertain writes or keep teardown waiting for a lost terminal receipt.
        if (
          command.type === "placementTools.complete" ||
          command.type === "placementTools.abandon" ||
          command.type === "placementTools.bindChild"
        ) {
          const operation = command.input.args[0];
          signal(
            operation.sourceSessionId,
            operation.sourceClaimId,
            new Error("Worker session operation outcome is unknown; restart recovery is required", {
              cause: error,
            }),
          );
        } else if (command.type === "placementTools.begin") {
          const { claim } = command.input.args[0];
          stagePlacementTurnToolWorkerPublication(context.admission.identity, {
            claim,
            toolNames: null,
          }).invalidate();
          signal(
            claim.sessionId,
            claim.claimId,
            new Error(
              "Worker session operation admission outcome is unknown; restart recovery is required",
              { cause: error },
            ),
          );
        }
        return undefined;
      },
    });
    try {
      return await mutation.run((scope) => scope.execute(command));
    } finally {
      admissionFence?.rollback();
    }
  }
  const input = <Args extends unknown[]>(args: [...Args]) => ({
    args,
    instanceId: runtime.instanceId,
    nowMs: runtime.now?.(),
  });
  const closeAdmission = (claim: WorkerSessionTurnClaim) => {
    context.admission.assertCurrent();
    return execute(
      { type: "placementTools.seal", input: input([claim]) },
      undefined,
      stagePlacementTurnToolWorkerPublication(context.admission.identity, {
        claim,
        toolNames: null,
      }),
    );
  };
  return {
    async authorizeWorkerTurnTools(
      claim: WorkerSessionTurnClaim,
      names: readonly string[],
      assertCurrent?: () => void,
    ): Promise<void> {
      await execute(
        { type: "placementTools.authorize", input: input([claim, names]) },
        assertCurrent,
      );
    },
    isWorkerTurnToolAuthorized(claim: WorkerSessionTurnClaim, name: string): boolean {
      try {
        context.admission.assertCurrent();
      } catch {
        return false;
      }
      return isPlacementTurnToolAuthorized(context.admission.identity, claim, name);
    },
    async closeWorkerTurnToolAdmission(claim: WorkerSessionTurnClaim): Promise<void> {
      await closeAdmission(claim);
    },
    async closeWorkerTurnToolState(claim: WorkerSessionTurnClaim): Promise<void> {
      await closeAdmission(claim);
      for (;;) {
        const id = key(claim.sessionId, claim.claimId);
        const waiting: Waiting = waiters.get(id) ?? {
          path: context.admission.identity.canonicalPath,
          listeners: new Set<Waiter>(),
        };
        const { listeners } = waiting;
        waiters.set(id, waiting);
        let finish: Waiter = () => {};
        const changed = new Promise<Error | undefined>((resolve) => {
          finish = resolve;
          listeners.add(finish);
        });
        try {
          // Subscribe before checking, so a terminal commit cannot race the teardown waiter.
          const cleared = await execute({ type: "placementTools.clear", input: input([claim]) });
          if (cleared.changed) {
            waiters.delete(id);
            return;
          }
          if (waiting.error) throw waiting.error;
          const error = await changed;
          if (error) throw error;
        } finally {
          listeners.delete(finish);
          if (!waiting.error && listeners.size === 0 && waiters.get(id) === waiting)
            waiters.delete(id);
        }
      }
    },
    async beginWorkerSessionToolOperation(
      params: Parameters<Kernel["begin"]>[0],
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTools.begin", input: input([params]) },
        assertCurrent,
      );
      if (!receipt.result) throw new Error("Worker session operation admission receipt is missing");
      return receipt.result;
    },
    async bindWorkerSessionToolOperationChild(...args: Parameters<Kernel["bindChild"]>) {
      const receipt = await execute({ type: "placementTools.bindChild", input: input(args) });
      return receipt.changed === true;
    },
    async completeWorkerSessionToolOperation(...args: Parameters<Kernel["complete"]>) {
      const receipt = await execute({ type: "placementTools.complete", input: input(args) });
      return receipt.changed === true;
    },
    async abandonWorkerSessionToolOperation(...args: Parameters<Kernel["abandon"]>) {
      const receipt = await execute({ type: "placementTools.abandon", input: input(args) });
      return receipt.changed === true;
    },
    async recoverWorkerSessionToolOperationsAfterRestart() {
      const receipt = await execute({ type: "placementTools.recover", input: input([]) });
      return receipt.recovered ?? 0;
    },
  };
}
