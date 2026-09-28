/** Classifies runtime executable paths for daemon command rendering. */
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;

function normalizeRuntimeBasename(execPath: string): string {
  const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const basename = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return basename.trim().toLowerCase();
}

/** Returns whether an executable path names a Node runtime binary. */
export function isNodeRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return (
    base === "node" ||
    base === "node.exe" ||
    base === "nodejs" ||
    base === "nodejs.exe" ||
    NODE_VERSIONED_PATTERN.test(base)
  );
}

/** Returns whether an executable path names a Bun runtime binary. */
export function isBunRuntime(execPath: string): boolean {
  const base = normalizeRuntimeBasename(execPath);
  return base === "bun" || base === "bun.exe";
}

const RUNTIME_MODULE_OPTIONS = new Set([
  "-r",
  "--preload",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const RUNTIME_VALUE_OPTIONS = new Set([
  ...RUNTIME_MODULE_OPTIONS,
  "-C",
  "--env-file",
  "--env-file-if-exists",
  "--tsconfig",
  "--cwd",
  "--conditions",
  "--icu-data-dir",
  "--openssl-config",
  "--title",
  "--disable-warning",
  "--disable-proto",
  "--cpu-prof-name",
  "--max-old-space-size",
]);
const RUNTIME_BOOLEAN_OPTIONS = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--expose-gc",
  "--jitless",
  "--no-opt",
  "--experimental-strip-types",
  "--bun",
]);

function attachedRuntimeModuleReference(arg: string): string | undefined {
  return arg.startsWith("-r") && !arg.startsWith("--") && arg.length > 2 ? arg.slice(2) : undefined;
}

/** Keep module-loading operands distinct from ordinary runtime option values. */
export function readRuntimeOptionOperands(
  args: readonly string[],
  endIndex: number,
): Array<{ index: number; value: string; loadsModule: boolean }> {
  const operands: Array<{ index: number; value: string; loadsModule: boolean }> = [];
  for (let index = 1; index < endIndex; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      break;
    }
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    const attached = attachedRuntimeModuleReference(arg);
    if (attached !== undefined) {
      operands.push({ index, value: attached, loadsModule: true });
    } else if (RUNTIME_VALUE_OPTIONS.has(option)) {
      const value = equals < 0 ? (args[++index] ?? "") : arg.slice(equals + 1);
      operands.push({ index, value, loadsModule: RUNTIME_MODULE_OPTIONS.has(option) });
    }
  }
  return operands;
}

export function resolveRuntimeScriptPosition(args: string[]):
  | number
  | { kind: "not-runtime" }
  | { kind: "other" }
  | {
      kind: "unclassified";
      reason: string;
      index: number;
      pendingSubcommand?: "run" | "watch";
    } {
  const executable = args[0] ?? "";
  const basename = executable.replaceAll("\\", "/").trim().toLowerCase().split("/").at(-1);
  const bun = isBunRuntime(executable);
  const tsx = basename === "tsx" || basename === "tsx.cmd";
  let pendingSubcommand: "run" | "watch" | undefined = bun ? "run" : tsx ? "watch" : undefined;
  if (!isNodeRuntime(executable) && !bun && !tsx) {
    return { kind: "not-runtime" };
  }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      return args[index + 1] ? index + 1 : { kind: "other" };
    }
    if (
      arg === "-e" ||
      arg === "--eval" ||
      arg === "-p" ||
      arg === "--print" ||
      arg === "--run" ||
      /^(?:--eval|--print|--run)=/.test(arg)
    ) {
      return { kind: "other" };
    }
    if (attachedRuntimeModuleReference(arg) !== undefined) {
      continue;
    } else if (RUNTIME_VALUE_OPTIONS.has(arg)) {
      index++;
    } else if (arg.startsWith("-")) {
      // A negated spelling proves a boolean; its absence never proves a value option.
      const negated = `--no-${arg.replace(/^--(?:no-)?/, "")}`;
      if (
        RUNTIME_BOOLEAN_OPTIONS.has(arg) ||
        /^--[^=]+=/.test(arg) ||
        (process.allowedNodeEnvironmentFlags.has(arg) &&
          process.allowedNodeEnvironmentFlags.has(negated))
      ) {
        continue;
      }
      return {
        kind: "unclassified",
        reason: `unsupported runtime option ${arg}`,
        index,
        pendingSubcommand,
      };
    } else if (arg === pendingSubcommand) {
      pendingSubcommand = undefined;
      continue;
    } else {
      return index;
    }
  }
  return { kind: "other" };
}
