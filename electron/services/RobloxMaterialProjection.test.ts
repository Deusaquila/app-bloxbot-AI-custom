import { afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeRobloxServiceLayer } from "./RobloxServiceLive";
import { RobloxService } from "./RobloxService";
import { StudioMcpBroker } from "./StudioMcpBroker";
import type { OpenCloudOptions } from "./RobloxOpenCloudAssetService";
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
function runtime(
  texturedParts = 0,
  respond?: (name: string, args: Record<string, unknown>) => CallToolResult,
  openCloud: Partial<OpenCloudOptions> = {},
) {
  const calls = vi.fn((name: string, args: Record<string, unknown>) =>
    Effect.succeed(
      respond?.(name, args) ?? {
        content: [{ type: "text" as const, text: JSON.stringify({ ...observed, texturedParts }) }],
      },
    ),
  );
  const broker = Layer.succeed(StudioMcpBroker, {
    info: { url: "test" },
    listTools: Effect.succeed({ tools: [] }),
    callTool: calls,
  });
  const rt = ManagedRuntime.make(
    makeRobloxServiceLayer({
      credentialPath: "unused",
      creator: { type: "user", id: "42" },
      ...openCloud,
    }).pipe(
      Layer.provide(broker),
    ),
  );
  return { rt, calls };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function importFixture() {
  const dir = await mkdtemp(join(tmpdir(), "bloxbot-studio-preflight-"));
  directories.push(dir);
  const path = join(dir, "export.fbx");
  const credentialPath = join(dir, "credential");
  const bytes = "test-only-fbx";
  await writeFile(path, bytes);
  await writeFile(credentialPath, "test-only-key");
  return {
    credentialPath,
    artifact: {
      id: "export",
      jobId: "job",
      type: "EXPORTED_FBX" as const,
      path,
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: Buffer.byteLength(bytes),
      createdAt: new Date().toISOString(),
    },
  };
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

  it("does not upload when the explicitly selected Studio is disconnected", async () => {
    const fixture = await importFixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { rt, calls } = runtime(
      0,
      () => ({ content: [{ type: "text", text: JSON.stringify({ studios: [{ id: "other-studio" }] }) }] }),
      { credentialPath: fixture.credentialPath, fetch },
    );
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.importAsset(fixture.artifact, "selected-studio"),
          ),
        ),
      ).rejects.toThrow("Roblox import failed");
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0][0]).toBe("list_roblox_studios");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });

  it("does not upload when the selected Studio is not in Edit mode", async () => {
    const fixture = await importFixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { rt, calls } = runtime(
      0,
      (name) => ({
        content: [
          {
            type: "text",
            text:
              name === "list_roblox_studios"
                ? JSON.stringify({ studios: [{ id: "selected-studio" }] })
                : "Current Studio Mode: Play",
          },
        ],
      }),
      { credentialPath: fixture.credentialPath, fetch },
    );
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.importAsset(fixture.artifact, "selected-studio"),
          ),
        ),
      ).rejects.toThrow("Roblox import failed");
      expect(calls.mock.calls.map(([name]) => name)).toEqual([
        "list_roblox_studios",
        "get_studio_state",
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });

  it("does not report an imported asset when Studio rejects insertion after upload", async () => {
    const fixture = await importFixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ path: "operations/test", done: false }))
      .mockResolvedValueOnce(Response.json({ done: true, response: { assetId: "123" } }));
    const { rt, calls } = runtime(
      0,
      (name) => ({
        isError: name === "insert_asset",
        content: [
          {
            type: "text",
            text:
              name === "list_roblox_studios"
                ? JSON.stringify({ studios: [{ id: "selected-studio" }] })
                : name === "get_studio_state"
                  ? "Current Studio Mode: Edit"
                  : "Studio insertion rejected",
          },
        ],
      }),
      { credentialPath: fixture.credentialPath, fetch, pollIntervalMs: 1 },
    );
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.importAsset(fixture.artifact, "selected-studio"),
          ),
        ),
      ).rejects.toThrow("Roblox import failed");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls.map(([name]) => name)).toEqual([
        "list_roblox_studios",
        "get_studio_state",
        "insert_asset",
      ]);
    } finally {
      await rt.dispose();
    }
  });
});
