import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { listSessionTranscriptArchivesInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  readSessionSqliteMigrationManifest,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import {
  runDoctorSessionSqlite,
  hasRetainedDoctorSessionSources,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

it("settles a pending plugin after removing the explicitly deleted session's archive copy", async () => {
  await withOpenClawTestState({ label: "issue-167385-deleted-copy" }, async (state) => {
    const { cfg, scope, storePath } = await seedDeferredPluginSessionSource(state, "default");
    const run = () =>
      runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
    await run();
    const deletion = await deleteSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
      archiveTranscript: true,
    });
    expect(deletion.deleted).toBe(true);
    expect(deletion.archivedTranscripts).toHaveLength(1);
    const archive = deletion.archivedTranscripts[0]!;
    fs.unlinkSync(archive.archivedPath);
    expect(
      await listSessionTranscriptArchivesInWorker({ ...scope, sessionIds: ["legacy-deleted"] }),
    ).toContainEqual(expect.objectContaining({ archiveName: path.basename(archive.archivedPath) }));
    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "issue 167385 deletion",
      run: async (authority) => {
        const report = await run();
        expect(hasRetainedDoctorSessionSources(report)).toBe(true);
        expect(fs.existsSync(storePath)).toBe(true);
        await settleRetainedDoctorSessionSources(report, ["fixture-plugin"], authority, () =>
          authority.assertCurrent(),
        );
        expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_settlement_failed" }),
        );
      },
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
  });
});

it("settles a pending plugin while a prior byte-identical import-original copy is missing", async () => {
  await withOpenClawTestState({ label: "issue-167385-import-copy" }, async (state) => {
    const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default");
    const run = () =>
      runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
    const imported = await run();
    const importedTarget = imported.targets[0]!;
    const owner = {
      agentId: importedTarget.agentId,
      storePath: importedTarget.storePath,
      sqlitePath: importedTarget.sqlitePath,
    };
    const directory = path.join(
      path.dirname(path.dirname(storePath)),
      "session-sqlite-import-archive",
    );
    fs.mkdirSync(directory, { recursive: true });
    const historicalBytes = JSON.stringify({ type: "session", version: 3, id: "history" }) + "\n";
    // Seed the older retained-original layout through its manifest producer, using real identities.
    const historicalRun = createSessionSqliteMigrationRun(state.env, [owner]);
    const copies = [1, 2].map((generation) => {
      const archivePath = path.join(directory, `archive-tier.history.jsonl.imported-${generation}`);
      fs.writeFileSync(archivePath, historicalBytes);
      const move: SessionSqliteMigrationMove = {
        kind: "unreferenced-jsonl",
        sourcePath: path.join(path.dirname(storePath), "history.jsonl"),
        archivePath,
        artifact: {
          identity: readMigrationArtifactIdentity(archivePath),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      recordPlannedMigrationMoves(historicalRun, owner, [move]);
      recordCompletedMigrationMoves(historicalRun, owner, [move]);
      return archivePath;
    });
    updateMigrationManifestTarget(historicalRun, owner, [], { validationBeforeArchive: "passed" });
    historicalRun.manifest.completedAt = historicalRun.manifest.startedAt;
    writeSessionSqliteMigrationManifest(historicalRun);
    fs.unlinkSync(copies[0]!);
    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "issue 167385 import original",
      run: async (authority) => {
        const report = await run();
        expect(hasRetainedDoctorSessionSources(report)).toBe(true);
        expect(fs.existsSync(storePath)).toBe(true);
        expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            code: "historical_transcript_deferred",
            message: expect.stringContaining("artifact is unexpectedly missing; original retained"),
          }),
        );
        await expect(
          settleRetainedDoctorSessionSources(report, ["fixture-plugin"], authority, () =>
            authority.assertCurrent(),
          ),
        ).resolves.toBeUndefined();
      },
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(
      readSessionSqliteMigrationManifest(historicalRun.manifestPath)?.targets[0]?.completedMoves,
    ).toContainEqual(
      expect.objectContaining({
        archivePath: copies[0],
        artifact: expect.objectContaining({ disposal: { state: "retained" } }),
      }),
    );
    expect(fs.existsSync(copies[0]!)).toBe(false);
    expect(fs.readFileSync(copies[1]!, "utf8")).toBe(historicalBytes);
  });
});
