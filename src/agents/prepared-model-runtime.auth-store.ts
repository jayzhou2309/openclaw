import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles/store-runtime.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

/** Merges runtime-only external auth over durable profiles for one replacement generation. */
export function loadPreparedModelRuntimeAuthStore(
  input: PreparedModelRuntimeInput,
): AuthProfileStore | undefined {
  const published = getPreparedRuntimeAuthProfileStoreSnapshot(
    input.agentDir,
    input.inheritedAuthDir,
  );
  if (
    !published ||
    (published.runtimeExternalProfileIds === undefined &&
      published.runtimeExternalProfileIdsAuthoritative !== true)
  ) {
    return undefined;
  }
  return mergeAuthProfileStores(
    ensureAuthProfileStoreWithoutExternalProfiles(input.agentDir, {
      allowKeychainPrompt: false,
      ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
      readOnly: true,
    }),
    published,
  );
}
