import { afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { inspectionCode, makeRobloxServiceLayer, parseRobloxFingerprint } from "./RobloxServiceLive";
import { RobloxService } from "./RobloxService";
import { StudioMcpBroker } from "./StudioMcpBroker";
import type { OpenCloudOptions } from "./RobloxOpenCloudAssetService";
import { matchesColor } from "./V1JobRunner";
const asset = { id: "123", studioId: "selected-studio", instanceName: "BloxBot_test" };
const opaqueBlack = [0, 0, 0, 1] as const;
function exportFingerprint(baseColor: readonly [number, number, number, number] = opaqueBlack) {
  return {
    assetId: "export",
    format: "fbx",
    objects: 1,
    meshes: 1,
    vertices: 8,
    triangles: 12,
    materials: [
      {
        name: "flat-material",
        baseColor,
        hasTextures: false,
        textureImages: [],
        alpha: baseColor[3],
      },
    ],
    dimensions: { x: 2, y: 4, z: 6 },
    transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
    rig: { exists: false },
    topology: {},
    geometry: {
      omittedMeshes: 0,
      meshes: [
        {
          objectId: "Mesh",
          vertices: 8,
          edges: 18,
          faces: 12,
          triangles: 12,
          unmappedFaces: 0,
          dimensions: { x: 2, y: 4, z: 6 },
          materialSlots: [
            { objectId: "Mesh", index: 0, materialName: "flat-material", assignedFaces: 12 },
          ],
        },
      ],
    },
    issues: [],
  };
}
const fingerprint = exportFingerprint();
const observed = {
  objects: 1,
  meshParts: 1,
  materials: 1,
  colors: [opaqueBlack],
  texturedParts: 0,
  dimensions: { x: 2, y: 4, z: 6 },
  hierarchyValid: true,
};
function runtime(
  texturedParts = 0,
  respond?: (name: string, args: Record<string, unknown>) => CallToolResult,
  openCloud: Partial<OpenCloudOptions> = {},
) {
  let projectedColor: readonly number[] = opaqueBlack;
  const calls = vi.fn((name: string, args: Record<string, unknown>) => {
    const custom = respond?.(name, args);
    if (custom) return Effect.succeed(custom);
    const code = typeof args.code === "string" ? args.code : "";
    if (code.includes("local expectedColor =")) {
      const receiptColor = code.match(/baseColor=\{([^}]+)\}/)?.[1].split(",").map(Number);
      if (receiptColor) projectedColor = receiptColor;
      return Effect.succeed({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ changedMeshes: observed.meshParts, baseColor: projectedColor }),
          },
        ],
      });
    }
    const result = {
      ...observed,
      colors: Array.from({ length: observed.objects }, () => projectedColor),
      texturedParts,
    };
    return Effect.succeed({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    });
  });
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
      expect(result.colors).toEqual([opaqueBlack]);
      expect(result.meshParts).toBe(1);
      expect(calls).toHaveBeenCalledTimes(3);
      expect(
        calls.mock.calls.every(
          ([name, args]) =>
            name === "execute_luau" &&
            args.studio_id === asset.studioId &&
            args.datamodel_type === "Edit",
        ),
      ).toBe(true);
      expect(calls.mock.calls[1][1].code).toContain("item.Color = expectedColor");
      expect(calls.mock.calls[1][1].code).toContain("local expectedMeshes = 1");
      expect(calls.mock.calls[1][1].code).toContain('assert(item.MaterialVariant == "", "Unexpected material variant")');
      expect(calls.mock.calls[2][1].code).not.toContain("item.Color =");
    } finally {
      await rt.dispose();
    }
  });
  it("projects a verified non-black opaque base color instead of forcing black", async () => {
    const color = [0.2, 0.4, 0.6, 1] as const;
    const { rt, calls } = runtime();
    try {
      const result = await rt.runPromise(
        Effect.flatMap(RobloxService, (service) =>
          service.applyVerifiedMaterial(asset, exportFingerprint(color)),
        ),
      );
      expect(result.colors).toEqual([color]);
      expect(calls.mock.calls[1][1].code).toContain("Color3.new(0.2, 0.4, 0.6)");
      expect(calls.mock.calls[1][1].code).toContain("baseColor={0.2,0.4,0.6,1}");
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
  it("rejects multi-material exports with an explicit unsupported reason", async () => {
    const multiMaterial = {
      ...fingerprint,
      materials: [
        ...fingerprint.materials,
        { ...fingerprint.materials[0], name: "second-material" },
      ],
    };
    const { rt, calls } = runtime();
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, multiMaterial),
          ),
        ),
      ).rejects.toThrow("multi-material and per-mesh-specific projection are unsupported");
      expect(calls).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });
  it("rejects ambiguous mesh-to-material evidence before changing Studio", async () => {
    const ambiguous = {
      ...fingerprint,
      geometry: {
        ...fingerprint.geometry,
        meshes: fingerprint.geometry.meshes.map((mesh) => ({
          ...mesh,
          materialSlots: [{ ...mesh.materialSlots[0], materialName: "unmapped-material" }],
        })),
      },
    };
    const { rt, calls } = runtime();
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, ambiguous),
          ),
        ),
      ).rejects.toThrow("not mapped to the single verified material");
      expect(calls).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });
  it("rejects an imported mesh count that cannot be matched to export evidence", async () => {
    const { rt, calls } = runtime(0, () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...observed, meshParts: 0 }),
        },
      ],
    }));
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, fingerprint),
          ),
        ),
      ).rejects.toThrow("Imported mesh count does not match the verified export material mapping");
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      await rt.dispose();
    }
  });
  it.each([
    ["unknown texture status", { hasTextures: undefined, textureImages: undefined }],
    ["texture-bearing material", { hasTextures: true, textureImages: ["diffuse.png"] }],
  ])("rejects %s from export evidence", async (_label, textureEvidence) => {
    const withTextureStatus = {
      ...fingerprint,
      materials: [{ ...fingerprint.materials[0], ...textureEvidence }],
    };
    const { rt, calls } = runtime();
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, withTextureStatus),
          ),
        ),
      ).rejects.toThrow("texture/material projection is unsupported");
      expect(calls).not.toHaveBeenCalled();
    } finally {
      await rt.dispose();
    }
  });
  it("rejects non-opaque alpha from export evidence", async () => {
    const translucent = exportFingerprint([0.2, 0.4, 0.6, 0.5]);
    const { rt, calls } = runtime();
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, translucent),
          ),
        ),
      ).rejects.toThrow("Non-opaque material alpha");
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
      ).rejects.toThrow("appearance overlays; refusing to overwrite");
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      await rt.dispose();
    }
  });

  it("counts a non-empty MaterialVariant as an appearance overlay and fails material compliance closed", async () => {
    const generatedInspection = inspectionCode(asset.instanceName);
    expect(generatedInspection).toContain('item.MaterialVariant ~= ""');

    // Studio inspection reports the variant through the legacy overlay count.
    const withVariant = parseRobloxFingerprint({
      ...observed,
      texturedParts: 1,
    });
    expect(matchesColor(withVariant, opaqueBlack)).toBe(false);

    const { rt, calls } = runtime(1);
    try {
      await expect(
        rt.runPromise(
          Effect.flatMap(RobloxService, (service) =>
            service.applyVerifiedMaterial(asset, fingerprint),
          ),
        ),
      ).rejects.toThrow("appearance overlays; refusing to overwrite");
      // The preflight prevents the projection script from clearing or masking the variant.
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0][1].code).toContain('item.MaterialVariant ~= ""');
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
