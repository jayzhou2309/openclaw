import { Type, type Static } from "typebox";
import { SESSIONS_SEND_RESULT_GUIDANCE } from "../tool-description-presets.js";

const text = Type.String({ minLength: 1, maxLength: 8 * 1024 });
const timeout = Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 }));

export const PlacedSessionsSpawnSchema = Type.Object(
  {
    task: text,
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    runTimeoutSeconds: timeout,
  },
  { additionalProperties: false },
);
export const PlacedSessionsSendSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 1_024 }),
    message: text,
    timeoutSeconds: timeout,
  },
  { additionalProperties: false },
);
export type PlacedSessionsSpawnArguments = Static<typeof PlacedSessionsSpawnSchema>;
export type PlacedSessionsSendArguments = Static<typeof PlacedSessionsSendSchema>;
export const PLACED_SESSIONS_SPAWN_DESCRIPTION =
  "Spawn a visible cloud child session in a fresh managed worktree. The child inherits the current cloud placement profile and attenuated tool policy.";
export const PLACED_SESSIONS_SEND_DESCRIPTION = `Send a message to an authorized parent, child, or sibling session on this Gateway, whether it runs on the Gateway, a paired device, or a cloud worker. Cross-tree and stale-incarnation targets are denied by the Gateway. ${SESSIONS_SEND_RESULT_GUIDANCE} Status "no_reply" is terminal; do not wait for another result.`;
