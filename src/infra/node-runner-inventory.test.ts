import { describe, expect, it } from "vitest";
import { availableWorkerSlots } from "../shared/node-list-parse.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
  type NodeWorkerCapacitySnapshot,
} from "./node-runner-inventory.js";

describe("idle worker capacity negotiation", () => {
  const declaration = (capacity: unknown, idleRetention?: unknown) => ({
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: {
      enabled: true,
      capacity,
      ...(idleRetention === undefined ? {} : { idleRetention }),
    },
  });

  it.each<[NodeWorkerCapacitySnapshot, true | undefined]>([
    [{ total: 1, available: 1 }, undefined],
    [{ total: 1, available: 0, reclaimableIdle: 1 }, true],
    [{ total: 4, available: 1, reclaimableIdle: 2 }, true],
  ])("preserves exact negotiated inventory shape %j", (capacity, idleRetention) => {
    const input = declaration(capacity, idleRetention);
    expect(parseNodeRunnerInventoryDeclaration(input)).toEqual(input);
    expect(availableWorkerSlots(capacity)).toBe(
      capacity.available + (capacity.reclaimableIdle ?? 0),
    );
  });

  it.each([
    [{ total: 1, available: 0, reclaimableIdle: 1 }, undefined],
    [{ total: 1, available: 1, reclaimableIdle: 1 }, true],
    [{ total: 4, available: 0, reclaimableIdle: 3 }, true],
    [{ total: 1, available: 0, reclaimableIdle: -1 }, true],
    [{ total: 1, available: 0, reclaimableIdle: 0.5 }, true],
    [{ total: 1, available: 0, reclaimableIdle: 0 }, false],
    [{ total: 1, available: 0, busy: 1 }, true],
  ])("rejects unnegotiated or invalid reclaimable capacity %j", (capacity, idleRetention) => {
    expect(parseNodeRunnerInventoryDeclaration(declaration(capacity, idleRetention))).toBeNull();
  });

  it.each([
    { enabled: false, capacity: { total: 1, available: 1 } },
    { enabled: true },
    { enabled: true, capacity: { total: 1, available: 1 }, bundleStatus: 1 },
    { enabled: true, capacity: { total: 1, available: 1 }, capturedExecPolicy: false },
    { enabled: true, capacity: { total: 1, available: 1 }, preparedWorkspace: 2 },
    Object.create({ enabled: true, capacity: { total: 1, available: 1 } }),
  ])("preserves closed host declarations and capability dependencies %j", (workerHost) => {
    expect(
      parseNodeRunnerInventoryDeclaration({
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost,
      }),
    ).toBeNull();
  });
});
