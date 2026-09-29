import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import type { DefaultProviderInit, defaultProvider } from "@aws-sdk/credential-provider-node";

/** Keep shared-file refresh on the chain that actually signs the Bedrock request. */
export function bedrockCredentialDefaultProvider(init: DefaultProviderInit) {
  // Load credentials lazily so discovery/registration and bearer-token requests do
  // not resolve AWS credentials. Each SDK client retains its own normal chain cache.
  let provider: ReturnType<typeof defaultProvider> | undefined;
  return async (...args: Parameters<ReturnType<typeof defaultProvider>>) => {
    const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
    provider ??= defaultProvider({ ...init, ignoreCache: true });
    return provider(...args);
  };
}

type CredentialProvider = ReturnType<typeof bedrockCredentialDefaultProvider>;

/** Everything the default chain reads to pick a credential source. */
async function credentialSourceKey(init: DefaultProviderInit): Promise<string> {
  const env = Object.entries(process.env)
    .filter(([name]) => name.startsWith("AWS_"))
    .toSorted(([a], [b]) => a.localeCompare(b));
  const files = await Promise.all(
    [
      process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".aws", "credentials"),
      process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), ".aws", "config"),
    ].map((file) => readFile(file, "utf8").catch(() => "")),
  );
  return JSON.stringify([init.profile, env, files]);
}

/**
 * Share one credential lookup across per-request clients. Credentials with an
 * expiration (instance role, SSO) are reused until near expiry, as long as the
 * env and shared files that select their source are unchanged. Ones without
 * are resolved per request so rotated profile files still apply. Each lookup
 * gets a fresh SDK chain because the chain memoizes non-expiring credentials.
 */
export function sharedBedrockCredentialDefaultProvider(): typeof bedrockCredentialDefaultProvider {
  let cached: { key: string; credentials: Awaited<ReturnType<CredentialProvider>> } | undefined;
  let pending: { key: string; credentials: ReturnType<CredentialProvider> } | undefined;
  return (init) =>
    async (...args) => {
      const key = await credentialSourceKey(init);
      const expiration = cached?.key === key ? cached.credentials.expiration : undefined;
      if (cached && expiration && expiration.getTime() - Date.now() > 5 * 60 * 1000) {
        return cached.credentials;
      }
      if (pending?.key !== key) {
        const lookup = {
          key,
          credentials: bedrockCredentialDefaultProvider(init)(...args)
            .then((credentials) => {
              cached = { key, credentials };
              return credentials;
            })
            .finally(() => {
              if (pending === lookup) {
                pending = undefined;
              }
            }),
        };
        pending = lookup;
      }
      return pending.credentials;
    };
}

/** Preserve explicit proxy and bearer authentication ahead of the default AWS chain. */
export function resolveBedrockRuntimeAuth(
  bearerToken?: string,
): Pick<
  BedrockRuntimeClientConfig,
  "credentialDefaultProvider" | "credentials" | "token" | "authSchemePreference"
> {
  const config: ReturnType<typeof resolveBedrockRuntimeAuth> = {
    credentialDefaultProvider: bedrockCredentialDefaultProvider,
  };
  if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
    if (process.versions?.node || process.versions?.bun) {
      config.credentials = {
        accessKeyId: "dummy-access-key",
        secretAccessKey: "dummy-secret-key",
      };
    }
  } else {
    const token = bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
    if (token !== undefined) {
      config.token = { token };
      config.authSchemePreference = ["httpBearerAuth"];
    }
  }
  return config;
}
