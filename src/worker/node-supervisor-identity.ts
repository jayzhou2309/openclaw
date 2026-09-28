import type { NodeWorkerSupervisorIdentity } from "./node-supervisor-protocol.js";

export function nodeWorkerTurnMatchesIdentity(
  receipt: NodeWorkerSupervisorIdentity,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    receipt.launchId === expected.launchId &&
    receipt.planHash === expected.planHash &&
    receipt.environmentId === expected.environmentId &&
    receipt.sessionId === expected.sessionId &&
    receipt.ownerEpoch === expected.ownerEpoch &&
    receipt.placementGeneration === expected.placementGeneration &&
    receipt.runId === expected.runId
  );
}
