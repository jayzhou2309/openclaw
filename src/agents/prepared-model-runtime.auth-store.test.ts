import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles/store-runtime.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { loadPreparedModelRuntimeAuthStore } from "./prepared-model-runtime.auth-store.js";

vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
}));
vi.mock("./auth-profiles/store.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshot: vi.fn(),
}));

const input = {
  config: {},
  agentDir: "/tmp/main-agent",
  inheritedAuthDir: "/tmp/main-agent",
};

describe("prepared model runtime auth store", () => {
  beforeEach(() => vi.resetAllMocks());

  it("retains durable OAuth when an external refresh publishes an empty overlay", () => {
    const durable: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "durable-access-not-real",
          refresh: "durable-refresh-not-real",
          expires: Date.now() + 60_000,
        },
      },
    };
    const published: AuthProfileStore = {
      version: 1,
      profiles: {},
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    };
    vi.mocked(ensureAuthProfileStoreWithoutExternalProfiles).mockReturnValue(durable);
    vi.mocked(getPreparedRuntimeAuthProfileStoreSnapshot).mockReturnValue(published);

    const result = loadPreparedModelRuntimeAuthStore(input);

    expect(result?.profiles["openai:default"]).toEqual(durable.profiles["openai:default"]);
    expect(ensureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledOnce();
  });

  it("avoids durable reads when no external runtime overlay exists", () => {
    vi.mocked(getPreparedRuntimeAuthProfileStoreSnapshot).mockReturnValue({
      version: 1,
      profiles: {},
    });

    expect(loadPreparedModelRuntimeAuthStore(input)).toBeUndefined();
    expect(ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
  });
});
