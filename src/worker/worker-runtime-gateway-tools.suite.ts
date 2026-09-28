import { expect, it } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  type WorkerGatewayToolInvokeParams,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerGatewayToolFixture = {
  setup: (options?: {
    inferencePlans: Array<
      | "session-tool"
      | "text"
      | { args: Record<string, unknown>; toolCallId: string; toolName: string }
    >;
  }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      gatewayToolRequests: WorkerGatewayToolInvokeParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
    };
    launch: WorkerLaunchDescriptor;
  }>;
};

export function registerWorkerGatewayToolAvailabilityTests({ setup }: WorkerGatewayToolFixture) {
  it("exposes exactly the Gateway-authorized worker tools", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
      "portal",
    ];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
      "portal",
    ]);
  });

  it("rejects a Gateway without the admitted tool-surface capability before inference", async () => {
    const { gateway, launch } = await setup();
    launch.admission.handshake.protocolFeatures =
      launch.admission.handshake.protocolFeatures.filter(
        (feature) => feature !== WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
      );

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "Gateway does not support the admitted worker tool surface.",
    );
    expect(gateway.inferenceRequests).toHaveLength(0);
  });

  it("runs with no tools when the Gateway authority is empty", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools ?? []).toEqual([]);
  });
}

export function registerWorkerGatewayToolRpcTests({ setup }: WorkerGatewayToolFixture) {
  it("runs an authorized nested-session tool through the generic Gateway transport", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["session-tool", "text"] });
    launch.assignment.toolAuthority.allowedToolNames = ["sessions_spawn"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.gatewayToolRequests).toEqual([
      {
        generation: "runtime-surface",
        toolId: "sessions_spawn",
        toolCallId: "nested-session-spawn-call",
        arguments: { task: "start a nested cloud child" },
      },
    ]);
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.transcriptRequests.flatMap((request) =>
        request.messages.flatMap((message) =>
          message.role === "toolResult" ? [message.toolName] : [],
        ),
      ),
    ).toContain("sessions_spawn");
  });

  it("returns Gateway presence to an authorized worker model through the generic Gateway transport", async () => {
    const args = { action: "person", person: "me", include: ["devices"] };
    const { gateway, launch } = await setup({
      inferencePlans: [{ toolName: "presence", toolCallId: "presence-read", args }, "text"],
    });
    launch.assignment.toolAuthority.allowedToolNames = ["presence"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    expect(gateway.gatewayToolRequests).toEqual([
      {
        generation: "runtime-surface",
        toolId: "presence",
        toolCallId: "presence-read",
        arguments: args,
      },
    ]);
    const result = gateway.transcriptRequests
      .flatMap((request) => request.messages)
      .find((message) => message.role === "toolResult" && message.toolName === "presence");
    expect(result).toMatchObject({ details: { status: "ok", people: [{ name: "Ada" }] } });
  });
}
