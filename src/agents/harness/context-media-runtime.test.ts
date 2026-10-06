import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { prepareHarnessContextMedia } from "./context-media-runtime.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("prepareHarnessContextMedia", () => {
  it("marks an unrestorable historical image neutrally instead of asking for a resend", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-media-"));
    workspaces.push(workspaceDir);
    const message = {
      role: "user",
      content: "what is this?",
      __openclaw: {
        media: [{ path: path.join(workspaceDir, "gone.png"), contentType: "image/png" }],
      },
    } as unknown as AgentMessage;

    const result = await prepareHarnessContextMedia({
      message,
      maxChars: 10_000,
      workspaceDir,
      modelInput: ["text", "image"],
      assertCurrent: () => {},
    });

    expect(result.images).toEqual([]);
    expect(result.text?.split("\n\n").at(-1)).toBe(
      "[1 referenced image not included in this context]",
    );
  });
});
