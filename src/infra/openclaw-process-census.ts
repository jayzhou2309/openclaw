import path from "node:path";
import { resolveRuntimeScriptPosition } from "../daemon/runtime-binary.js";
import { isLegacyPluginSourceCaptureName } from "../plugins/plugin-source-capture-path.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import { readProcessGroupMembers } from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import {
  classifyOpenClawArgv,
  classifyOpenClawEntrypointPath,
  readProcessWorkingDirectories,
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
      .filter(({ pid, state, command }) => {
        if (pid === process.pid || launchers.has(pid)) {
          return false;
        }
        if (state.startsWith("Z") && isPidDefinitelyDead(pid)) {
          return false;
        }
        if (!command || !("argv" in command)) {
          return false;
        }
        // Retained terminal writers can use node --eval with the runtime path in argv.
        if (command.argv.some(referencesRetainedArtifact)) {
          return true;
        }
        const cwd = directories.get(pid);
        const identity = classifyOpenClawArgv(command.argv, {
          pid,
          cwd: cwd ?? "",
          serviceMarker: command.serviceMarker,
          additionalEntrypoints: workerEntrypoints,
        });
        if (
          identity.kind === "openclaw" ||
          referencesRetainedArtifact(cwd ?? "") ||
          (identity.kind === "unclassified" &&
            command.argv.some(
              (arg) =>
                classifyOpenClawEntrypointPath(arg, {
                  cwd: cwd ?? "",
                  additionalEntrypoints: workerEntrypoints,
                }).kind === "openclaw",
            ))
        ) {
          return true;
        }
        if (command.argv.length > 0 && (!cwd || !path.isAbsolute(cwd))) {
          const position = resolveRuntimeScriptPosition(command.argv);
          const entrypoint =
            typeof position === "number"
              ? command.argv[position]
              : position.kind === "not-runtime"
                ? command.argv[0]
                : undefined;
          // Unfamiliar syntax is not custody, but missing cwd cannot resolve a relative entrypoint.
          if (!entrypoint || !path.isAbsolute(entrypoint)) {
            throw new Error(
              `Could not classify PID ${pid}: working directory is unavailable for its entrypoint.`,
            );
          }
        }
        return false;
      })
      .map(({ pid }) => pid);
    return { pids };
  } catch (error) {
    return { error: `Could not inspect OpenClaw processes: ${String(error)}` };
  }
}
