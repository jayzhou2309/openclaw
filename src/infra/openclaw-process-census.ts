import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBunRuntime,
  readRuntimeOptionOperands,
  resolveRuntimeScriptPosition,
} from "../daemon/runtime-binary.js";
import { isLegacyPluginSourceCaptureName } from "../plugins/plugin-source-capture-path.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import {
  classifyOpenClawArgv,
  classifyOpenClawEntrypointPath,
  readProcessPackageIdentity,
  readProcessWorkingDirectories,
  type OpenClawArgvClassification,
} from "./gateway-process-argv.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const workerEntrypoints = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`src/infra/${entry.sourceWorkerName}.ts`),
  `dist/${entry.distWorkerPath}`,
]);

function referencesRetainedArtifact(value: string): boolean {
  return value
    .split(/[\\/=]/u)
    .some(
      (part) =>
        isLegacyPluginSourceCaptureName(part) ||
        /^openclaw-update-runtime-[A-Za-z0-9]{6}$/u.test(part),
    );
}

type ProcessArtifactCustody =
  | { kind: "holder" }
  | { kind: "non-holder" }
  | { kind: "unresolved"; reason: string };

function assertNeverProcessEvidence(evidence: never): never {
  throw new Error(`Unhandled process evidence: ${String(evidence)}`);
}

function entrypointCustody(identity: OpenClawArgvClassification): ProcessArtifactCustody {
  switch (identity.kind) {
    case "openclaw":
      return { kind: "holder" };
    case "unclassified":
      return { kind: "unresolved", reason: identity.reason };
    case "other":
      switch (identity.packageIdentity.kind) {
        case "openclaw":
          return { kind: "holder" };
        case "foreign":
          return { kind: "non-holder" };
        case "unclassified":
          return { kind: "unresolved", reason: identity.packageIdentity.reason };
        case "not-inspected":
          return { kind: "unresolved", reason: "entrypoint package identity is unavailable" };
      }
      return assertNeverProcessEvidence(identity.packageIdentity);
  }
  return assertNeverProcessEvidence(identity);
}

function classifyProcessArtifactCustody(
  command: ProcessCommand | undefined,
  pid: number,
  cwd: string | undefined,
): ProcessArtifactCustody {
  if (!command) {
    return { kind: "unresolved", reason: "process command is unavailable" };
  }
  // The command reader admits these only for observed foreign UIDs or kernel/dead processes.
  if ("argvUnavailable" in command || command.argv.length === 0) {
    return { kind: "non-holder" };
  }
  const { argv, serviceMarker } = command;
  if (argv.some(referencesRetainedArtifact) || referencesRetainedArtifact(cwd ?? "")) {
    return { kind: "holder" };
  }
  const identity = classifyOpenClawArgv(argv, {
    pid,
    cwd: cwd ?? "",
    serviceMarker,
    additionalEntrypoints: workerEntrypoints,
  });
  if (identity.kind === "openclaw") {
    return { kind: "holder" };
  }
  if (identity.kind === "other" && identity.packageIdentity.kind !== "not-inspected") {
    const evidence = entrypointCustody(identity);
    if (evidence.kind !== "non-holder") {
      return evidence;
    }
  }
  if (identity.kind === "unclassified" && identity.cause !== "runtime-syntax") {
    return { kind: "unresolved", reason: identity.reason };
  }
  if (!cwd || !path.isAbsolute(cwd)) {
    return { kind: "unresolved", reason: "working directory is unavailable" };
  }
  const position = resolveRuntimeScriptPosition(argv);
  const native = typeof position !== "number" && position.kind === "not-runtime";
  const operands = native
    ? []
    : readRuntimeOptionOperands(argv, typeof position === "number" ? position : argv.length);
  for (const { value: specifier, loadsModule } of operands) {
    if (!loadsModule) {
      continue;
    }
    if (!specifier) {
      return { kind: "unresolved", reason: "runtime module reference is unavailable" };
    }
    let modulePath = specifier;
    if (specifier.startsWith("file:")) {
      try {
        modulePath = fileURLToPath(specifier);
      } catch {
        return { kind: "unresolved", reason: "runtime module path is unavailable" };
      }
    } else if (
      !path.isAbsolute(specifier) &&
      !specifier.startsWith("./") &&
      !specifier.startsWith("../")
    ) {
      // Package specifiers use the inspected runtime's resolution context, not this process's cwd.
      return { kind: "unresolved", reason: "runtime module package identity is unavailable" };
    }
    const evidence = entrypointCustody(
      classifyOpenClawEntrypointPath(modulePath, {
        cwd,
        additionalEntrypoints: workerEntrypoints,
      }),
    );
    if (evidence.kind !== "non-holder") {
      return evidence;
    }
  }
  if (!native && !(identity.kind === "other" && identity.packageIdentity.kind === "foreign")) {
    const pkg = readProcessPackageIdentity(cwd, true);
    if (pkg.kind === "unclassified") {
      return { kind: "unresolved", reason: pkg.reason };
    }
    if (pkg.kind === "openclaw") {
      return { kind: "holder" };
    }
    if (identity.kind === "unclassified") {
      // Only syntax ambiguity reaches this path; failed inspections above cannot be overridden.
      const optionOperands = new Set(operands.map(({ index }) => index));
      let pendingSubcommand = identity.pendingSubcommand;
      for (let index = identity.syntaxIndex; index < argv.length; index++) {
        if (optionOperands.has(index)) {
          continue;
        }
        const argument = argv[index]!;
        if (argument === "--") {
          pendingSubcommand = undefined;
          continue;
        }
        if (argument === pendingSubcommand) {
          pendingSubcommand = undefined;
          continue;
        }
        if (!argument.startsWith("-")) {
          pendingSubcommand = undefined;
        }
        let operand = argument;
        if (argument.startsWith("-")) {
          const equals = argument.indexOf("=");
          if (equals < 0) {
            continue;
          }
          operand = argument.slice(equals + 1);
          if (!/[\\/]/u.test(operand) && operand !== "openclaw") {
            continue;
          }
        }
        // Bun's extensionless package tasks take precedence over a same-named file.
        if (
          isBunRuntime(argv[0] ?? "") &&
          !/[\\/]/u.test(operand) &&
          !path.extname(operand) &&
          pkg.scripts.has(operand)
        ) {
          continue;
        }
        const evidence = entrypointCustody(
          classifyOpenClawEntrypointPath(operand, {
            cwd,
            additionalEntrypoints: workerEntrypoints,
          }),
        );
        if (evidence.kind !== "non-holder") {
          return evidence;
        }
      }
    }
  }
  return { kind: "non-holder" };
}

/** Incomplete process inspection never authorizes reclamation of unowned scratch. */
export function inspectOtherOpenClawProcesses(): { pids: number[] } | { error: string } {
  try {
    if (process.platform === "linux" && isContainerEnvironment()) {
      throw new Error(
        "Host process visibility cannot be established from this container. Run Doctor on the host after stopping OpenClaw containers that share its temporary directory.",
      );
    }
    const processes = [
      ...readProcessGroupMembers(1_000, { readDarwinCommand: readDarwinProcessCommand }),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const current = byPid.get(process.pid);
    if (!current?.command || processes.some((entry) => !entry.command)) {
      throw new Error("OpenClaw process census is incomplete.");
    }
    const directories = readProcessWorkingDirectories(processes.map(({ pid }) => pid));
    const launchers = new Set<number>();
    const ancestors = new Set<number>([process.pid]);
    let parentPid = current.command.ppid;
    while (parentPid > 0) {
      const parent = byPid.get(parentPid);
      if (!parent?.command || ancestors.has(parentPid)) {
        throw new Error("OpenClaw process ancestry is incomplete.");
      }
      ancestors.add(parentPid);
      if ("argv" in parent.command) {
        const { argv, serviceMarker } = parent.command;
        const identity = classifyOpenClawArgv(argv, {
          pid: parentPid,
          cwd: directories.get(parentPid) ?? "",
          serviceMarker,
          additionalEntrypoints: workerEntrypoints,
        });
        // Only the exact CLI launcher waiting for this Doctor is exempt, never a retitled parent.
        if (
          identity.kind === "openclaw" &&
          identity.entryIndex !== undefined &&
          getRootOptionAwareCommandPath(["node", ...argv.slice(identity.entryIndex)], 1)[0] ===
            "doctor"
        ) {
          launchers.add(parentPid);
        }
      }
      parentPid = parent.command.ppid;
    }
    const pids = processes
      .filter(({ pid, state, command }): boolean => {
        if (pid === process.pid || launchers.has(pid)) {
          return false;
        }
        if (state.startsWith("Z") && isPidDefinitelyDead(pid)) {
          return false;
        }
        const custody = classifyProcessArtifactCustody(command, pid, directories.get(pid));
        switch (custody.kind) {
          case "holder":
            return true;
          case "non-holder":
            return false;
          case "unresolved":
            throw new Error(`Could not classify PID ${pid}: ${custody.reason}`);
        }
        return assertNeverProcessEvidence(custody);
      })
      .map(({ pid }) => pid);
    return { pids };
  } catch (error) {
    return { error: `Could not inspect OpenClaw processes: ${String(error)}` };
  }
}
