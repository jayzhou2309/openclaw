import { Type, type Static } from "typebox";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { createPlacementSessionToolOperationKernel } from "./placement-session-tool-operations.kernel.js";

type Kernel = ReturnType<typeof createPlacementSessionToolOperationKernel>;
const OperationStartSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("execute"),
    operationSeed: Type.String(),
  }),
  Type.Object({ kind: Type.Literal("completed"), resultJson: Type.String() }),
  Type.Object({ kind: Type.Literal("in-progress") }),
  Type.Object({ kind: Type.Literal("unknown") }),
  Type.Object({ kind: Type.Literal("capacity") }),
  Type.Object({ kind: Type.Literal("conflict") }),
  Type.Object({ kind: Type.Literal("unauthorized") }),
]);
export type WorkerSessionToolOperationStart = Static<typeof OperationStartSchema>;
export const PlacementSessionToolReceiptSchema = Type.Object({
  result: Type.Optional(OperationStartSchema),
  changed: Type.Optional(Type.Boolean()),
  recovered: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  toolNames: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});
export type PlacementSessionToolReceipt = Static<typeof PlacementSessionToolReceiptSchema>;
export type PlacementSessionToolWorkerOperations = {
  [Method in keyof Kernel as `placementTools.${Method}`]: {
    input: { args: Parameters<Kernel[Method]>; instanceId: string; nowMs?: number };
    output: PlacementSessionToolReceipt;
  };
};
export function isPlacementSessionToolCommand(command: {
  type: PropertyKey;
}): command is SqliteWorkerCommand<PlacementSessionToolWorkerOperations> {
  return typeof command.type === "string" && command.type.startsWith("placementTools.");
}
