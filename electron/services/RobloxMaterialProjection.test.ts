import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeRobloxServiceLayer } from "./RobloxServiceLive";
import { RobloxService } from "./RobloxService";
import { StudioMcpBroker } from "./StudioMcpBroker";
const asset = { id: "123", studioId: "selected-studio", instanceName: "BloxBot_test" };
const fingerprint = {
  assetId: "export",
  format: "fbx",
  objects: 1,
  meshes: 1,
  vertices: 8,
  triangles: 12,
  materials: [{ name: "black", baseColor: [0, 0, 0, 1] }],
  dimensions: { x: 2, y: 4, z: 6 },
  transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
  rig: { exists: false },
  topology: {},
  issues: [],
};
const observed = {
  objects: 1,
  materials: 1,
  colors: [[0, 0, 0, 1]],
  texturedParts: 0,
  dimensions: { x: 2, y: 4, z: 6 },
  hierarchyValid: true,
};
function runtime(texturedParts = 0) {
  const calls = vi.fn((_name: string, _args: Record<string, unknown>) =>
    Effect.succeed({
      content: [{ type: "text" as const, text: JSON.stringify({ ...observed, texturedParts }) }],
    }),
  );
  const broker = Layer.succeed(StudioMcpBroker, {
    info: { url: "test" },
    listTools: Effect.succeed({ tools: [] }),
    callTool: calls,
  });
  const rt = ManagedRuntime.make(
    makeRobloxServiceLayer({ credentialPath: "unused", creator: { type: "user", id: "42" } }).pipe(
      Layer.provide(broker),
    ),
  );
  return { rt, calls };
}
describe("Verified material projection", () => {
  it("targets the explicit imported model and reinspects after projection", async () => {
    const { rt, calls } = runtime();
    try {
      const result = await rt.runPromise(
        Effect.flatMap(RobloxService, (s) => s.applyVerifiedMaterial(asset, fingerprint)),
      );
      expect(result.colors).toEqual([[0, 0, 0, 1]]);
      expect(calls).toHaveBeenCalledTimes(3);
      expect(
        calls.mock.calls.every(
          ([name, args]) =>
            name === "execute_luau" &&
            args.studio_id === asset.studioId &&
            args.datamodel_type === "Edit",
        ),
      ).toBe(true);
      expect(calls.mock.calls[1][1].code).toContain("item.Color = Color3.new(0, 0, 0)");
      expect(calls.mock.calls[2][1].code).not.toContain("item.Color =");
    } finally {
      await rt.dispose();
    }
  });
  it("rejects absent exported material evidence without mutating Studio", async () => {
    const { rt, calls } = runtime();
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (s) =>
            s.applyVerifiedMaterial(asset, { ...fingerprint, materials: [] }),
          ),
        ),
      ).rejects.toThrow();
      expect(calls).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });
  it("does not overwrite unexpected imported texture overlays", async () => {
    const { rt, calls } = runtime(1);
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (s) => s.applyVerifiedMaterial(asset, fingerprint)),
        ),
      ).rejects.toThrow();
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      await rt.dispose();
    }
  });
});
