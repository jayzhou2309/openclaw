// Parses gateway process command lines for process discovery.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  isBunRuntime,
  isNodeRuntime,
  resolveRuntimeScriptPosition,
} from "../daemon/runtime-binary.js";
import { isLegacyPluginSourceCaptureName } from "../plugins/plugin-source-capture-path.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

function normalizeProcArg(arg: string): string {
  return normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/"));
}

const ENTRY_CANDIDATES = [
  "openclaw.mjs",
  "dist/index.js",
  "dist/entry.js",
  "scripts/run-node.mjs",
  "src/entry.ts",
  "src/index.ts",
] as const;

type ProcessInspectionFailure = {
  kind: "unclassified";
  cause: "cwd" | "script" | "package-identity" | "service-marker";
  reason: string;
};

export type OpenClawArgvClassification =
  | {
      kind: "openclaw";
      entryIndex?: number;
      packageIdentity?: { root: string; entrypoint: string };
    }
  | { kind: "other"; packageIdentity: ProcessPackageIdentity | { kind: "not-inspected" } }
  | ProcessInspectionFailure
  | {
      kind: "unclassified";
      cause: "runtime-syntax";
      syntaxIndex: number;
      pendingSubcommand?: "run" | "watch";
      reason: string;
    };

type ProcessPackageIdentity =
  | { kind: "openclaw" }
  | { kind: "foreign"; scripts: ReadonlySet<string> }
  | ProcessInspectionFailure;

/** Missing nested manifests may lead to an ancestor; unreadable or invalid identities never do. */
export function readProcessPackageIdentity(
  directory: string,
  searchParents = false,
): ProcessPackageIdentity {
  let current = directory;
  for (;;) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
    } catch (error) {
      const parent = path.dirname(current);
      if (
        searchParents &&
        extractErrorCode(error) === "ENOENT" &&
        parent !== current &&
        path.basename(current) !== "node_modules"
      ) {
        current = parent;
        continue;
      }
      return {
        kind: "unclassified",
        cause: "package-identity",
        reason: "could not read package identity",
      };
    }
    if (
      !isRecord(manifest) ||
      typeof manifest.name !== "string" ||
      !manifest.name.trim() ||
      manifest.name !== manifest.name.trim()
    ) {
      return {
        kind: "unclassified",
        cause: "package-identity",
        reason: "package identity has no valid name",
      };
    }
    if (manifest.name === "openclaw") {
      return { kind: "openclaw" };
    }
    const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
    return {
      kind: "foreign",
      scripts: new Set(
        Object.entries(scripts)
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([name]) => name),
      ),
    };
  }
}


type ClassificationOptions = {
  command?: string;
  serviceMarker?: string;
  owner?: GatewayOwnerLeaseIdentity;
  port?: number;
  cwd?: string;
  pid?: number;
  additionalEntrypoints?: readonly string[];
  /** Mutation admission needs package evidence, rather than executable-name hints. */
  requirePackageIdentity?: boolean;
};

export function readProcessWorkingDirectories(pids: readonly number[]): Map<number, string> {
  const requested = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const directories = new Map<number, string>();
  if (requested.size === 0) {
    return directories;
  }
  if (process.platform === "linux") {
    for (const pid of requested) {
      try {
        directories.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // A disappearing or inaccessible PID does not erase another PID's evidence.
      }
    }
    return directories;
  }
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "/usr/sbin/lsof",
        ["-a", "-p", [...requested].join(","), "-d", "cwd", "-F0pn"],
        {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
          env: resolveDiagnosticProcessEnv(),
        },
      );
      // Exit 1 can accompany useful records when another selected PID disappears.
      if (result.error || (result.status !== 0 && result.status !== 1)) {
        return directories;
      }
      const fields = result.stdout.split("\0");
      fields.pop(); // Only complete NUL-terminated fields establish a path.
      const ambiguous = new Set<number>();
      let pid: number | undefined;
      for (const raw of fields) {
        const field = raw.replace(/^\n/, "");
        if (field.startsWith("p")) {
          const candidate = /^p(\d+)$/.exec(field);
          pid = candidate && requested.has(Number(candidate[1])) ? Number(candidate[1]) : undefined;
        } else if (pid !== undefined && field.startsWith("n") && path.isAbsolute(field.slice(1))) {
          if (directories.has(pid)) {
            directories.delete(pid);
            ambiguous.add(pid);
          } else if (!ambiguous.has(pid)) {
            directories.set(pid, field.slice(1));
          }
        }
      }
    }
  } catch {
    // An inaccessible cwd never licenses resolving against this inspector's cwd.
  }
  return directories;
}

/** Generic script names identify OpenClaw only inside a verified package root. */
function classifyEntrypoint(
  args: string[],
  opts: ClassificationOptions = {},
): OpenClawArgvClassification {
  const exe = normalizeProcArg(args[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  if (!opts.requirePackageIdentity && (exe.endsWith("/openclaw") || exe === "openclaw")) {
    return { kind: "openclaw", entryIndex: 0 };
  }
  const entryIndex = /(?:^|\/)openclaw\.mjs$/.test(exe) ? 0 : resolveRuntimeScriptPosition(args);
  if (typeof entryIndex !== "number") {
    return entryIndex.kind === "unclassified"
      ? {
          kind: "unclassified",
          cause: "runtime-syntax",
          syntaxIndex: entryIndex.index,
          pendingSubcommand: entryIndex.pendingSubcommand,
          reason: entryIndex.reason,
        }
      : { kind: "other", packageIdentity: { kind: "not-inspected" } };
  }
  const identity = classifyOpenClawEntrypointPath(args[entryIndex]!, opts);
  return identity.kind === "openclaw" ? { ...identity, entryIndex } : identity;
}

/** Path evidence is shared with cleanup even when launcher syntax is unfamiliar. */
export function classifyOpenClawEntrypointPath(
  script: string,
  opts: Pick<ClassificationOptions, "cwd" | "pid" | "additionalEntrypoints" | "requirePackageIdentity"> = {},
): OpenClawArgvClassification {
  const normalized = normalizeProcArg(script);
  if (!opts.requirePackageIdentity && /(?:^|\/)openclaw\.mjs$/.test(normalized)) {
    return { kind: "openclaw" };
  }
  const entrypoints = [...ENTRY_CANDIDATES, ...(opts.additionalEntrypoints ?? [])];
  let scriptPath = script;
  if (!path.isAbsolute(script)) {
    const cwd =
      opts.cwd ??
      (opts.pid === undefined
        ? undefined
        : readProcessWorkingDirectories([opts.pid]).get(opts.pid));
    if (!cwd || !path.isAbsolute(cwd)) {
      return { kind: "unclassified", cause: "cwd", reason: "working directory is unavailable" };
    }
    scriptPath = path.resolve(cwd, script);
  }
  let resolved: string;
  let directory: boolean;
  try {
    resolved = fs.realpathSync(scriptPath);
    const stat = fs.statSync(resolved);
    if (opts.requirePackageIdentity && !stat.isFile()) {
      return { kind: "unclassified", cause: "script", reason: `entrypoint is not a regular file: ${script}` };
    }
    directory = stat.isDirectory();
  } catch {
    return { kind: "unclassified", cause: "script", reason: "could not resolve script" };
  }
  const resolvedNormalized = normalizeProcArg(resolved);
  const entry = directory
    ? undefined
    : entrypoints.find((candidate) => resolvedNormalized.endsWith(`/${candidate}`));
  const root = entry
    ? resolved.slice(0, -entry.length)
    : directory
      ? resolved
      : path.dirname(resolved);
  const identity = readProcessPackageIdentity(root, !entry && !directory);
  if (entry && identity.kind === "unclassified") {
    return identity;
  }
  return entry && identity.kind === "openclaw"
    ? {
        kind: "openclaw",
        ...(opts.requirePackageIdentity
          ? { packageIdentity: { root: path.resolve(root), entrypoint: resolved } }
          : {}),
      }
    : { kind: "other", packageIdentity: identity };
}

export function parseProcCmdline(raw: string): string[] {
  return normalizeStringEntries(raw.split("\0"));
}

/** One classification for process owners, command consumers, and diagnostics. */
export function classifyOpenClawArgv(
  args: string[],
  opts: ClassificationOptions = {},
): OpenClawArgvClassification {
  const { command, owner, pid, port } = opts;
  if (
    !opts.requirePackageIdentity &&
    command === "gateway" &&
    owner?.pid === pid &&
    owner?.state === "live" &&
    (port === undefined || owner.port === port)
  ) {
    return { kind: "openclaw" };
  }
  const executable =
    normalizeProcArg(args[0] ?? "")
      .split("/")
      .at(-1)
      ?.replace(/\.(exe|cmd|bat)$/, "") ?? "";
  if (!opts.requirePackageIdentity && /^openclaw-[a-z0-9-]+$/.test(executable)) {
    return !command || executable === `openclaw-${command}`
      ? { kind: "openclaw" }
      : { kind: "other", packageIdentity: { kind: "not-inspected" } };
  }
  const identity = classifyEntrypoint(args, opts);
  if (command) {
    return identity.kind === "openclaw" &&
      normalizeProcArg(
        getRootOptionAwareCommandPath(["node", ...args.slice(identity.entryIndex)], 1)[0] ?? "",
      ) !== command
      ? { kind: "other", packageIdentity: { kind: "not-inspected" } }
      : identity;
  }
  if (
    identity.kind === "openclaw" ||
    (!opts.requirePackageIdentity &&
      args.some((arg) =>
        arg.replaceAll("\\", "/").split("/").some(isLegacyPluginSourceCaptureName),
      ))
  ) {
    return identity.kind === "openclaw" ? identity : { kind: "openclaw" };
  }
  let marker = opts.serviceMarker;
  if (
    pid !== undefined &&
    process.platform === "linux" &&
    (isNodeRuntime(executable) || isBunRuntime(executable) || executable === "tsx")
  ) {
    try {
      marker = fs
        .readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .find((entry) => entry.startsWith("OPENCLAW_SERVICE_MARKER="))
        ?.slice("OPENCLAW_SERVICE_MARKER=".length);
    } catch (error) {
      return {
        kind: "unclassified",
        cause: "service-marker",
        reason: `process identity inspection failed (${extractErrorCode(error) ?? "unavailable"})`,
      };
    }
  }
  return !opts.requirePackageIdentity && marker === "openclaw" ? { kind: "openclaw" } : identity;
}
