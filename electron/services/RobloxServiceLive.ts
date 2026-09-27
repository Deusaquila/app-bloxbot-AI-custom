import { randomUUID } from "node:crypto";
import { AssetFingerprintSchema } from "../../src/types/asset";
import type { AssetFingerprint } from "../../src/types/asset";
import { Effect, Layer, Schema } from "effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  RobloxService,
  RobloxServiceError,
  type RobloxAssetRef,
  type RobloxAssetFingerprint,
} from "./RobloxService";
import { StudioMcpBroker } from "./StudioMcpBroker";
import { RobloxOpenCloudAssetService, type OpenCloudOptions } from "./RobloxOpenCloudAssetService";

export function readStudioJson(result: CallToolResult): unknown {
  if (result.isError) throw new Error("Studio tool failed");
  return JSON.parse(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
}
export function inspectionCode(instanceName: string): string {
  if (!/^BloxBot_[a-zA-Z0-9_-]+$/.test(instanceName))
    throw new Error("Invalid BloxBot instance name");
  return `
local matches = {}
for _, child in workspace:GetChildren() do
  if child.Name == "${instanceName}" then table.insert(matches, child) end
end
assert(#matches == 1, "Expected exactly one imported asset")
local root = matches[1]
assert(root:IsA("Model"), "Imported asset must be a Model")
local pivot = root:GetPivot()
local parts, colors, textured, meshParts = {}, {}, 0, 0
local lo, hi = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
for _, item in root:GetDescendants() do
  assert(not item:IsA("LuaSourceContainer"), "Imported geometry contains scripts")
  if item:IsA("BasePart") and not (item.ClassName == "Part" and item.Name == "RootPart" and item.Transparency == 1) then
    table.insert(parts, item)
    table.insert(colors, {item.Color.R, item.Color.G, item.Color.B, 1-item.Transparency})
    if item:IsA("MeshPart") then meshParts += 1 end
    -- texturedParts is the legacy evidence field for any visual overlay that
    -- can change the verified flat color, including MeshPart material variants.
    local hasAppearanceOverlay = item:IsA("MeshPart") and (item.TextureID ~= "" or item.MaterialVariant ~= "")
    for _, child in item:GetDescendants() do
      if child:IsA("SurfaceAppearance") or child:IsA("Texture") or child:IsA("Decal") then hasAppearanceOverlay = true end
    end
    if hasAppearanceOverlay then textured += 1 end
    local cf = pivot:ToObjectSpace(item.CFrame)
    for x=-1,1,2 do for y=-1,1,2 do for z=-1,1,2 do
      local p = cf * (item.Size * Vector3.new(x,y,z) / 2)
      lo = Vector3.new(math.min(lo.X,p.X),math.min(lo.Y,p.Y),math.min(lo.Z,p.Z))
      hi = Vector3.new(math.max(hi.X,p.X),math.max(hi.Y,p.Y),math.max(hi.Z,p.Z))
    end end end
  end
end
assert(#parts > 0, "Imported asset has no parts")
local d = hi-lo
return game:GetService("HttpService"):JSONEncode({objects=#parts, materials=#colors, colors=colors,
 meshParts=meshParts, texturedParts=textured, dimensions={x=d.X,y=d.Y,z=d.Z}, hierarchyValid=root.Parent==workspace})
`;
}
export function parseRobloxFingerprint(value: unknown): RobloxAssetFingerprint {
  const v = value as RobloxAssetFingerprint;
  if (
    !v ||
    !Number.isInteger(v.objects) ||
    v.objects <= 0 ||
    !Number.isInteger(v.materials) ||
    v.materials <= 0 ||
    typeof v.hierarchyValid !== "boolean" ||
    !Number.isInteger(v.texturedParts) ||
    v.texturedParts < 0 ||
    (v.meshParts !== undefined &&
      (!Number.isInteger(v.meshParts) || v.meshParts < 0 || v.meshParts > v.objects)) ||
    !v.dimensions ||
    ![v.dimensions.x, v.dimensions.y, v.dimensions.z].every((n) => Number.isFinite(n) && n >= 0) ||
    !Array.isArray(v.colors) ||
    v.colors.length !== v.objects ||
    !v.colors.every(
      (c) =>
        Array.isArray(c) &&
        c.length === 4 &&
        c.every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
    )
  )
    throw new Error("Invalid Roblox asset evidence");
  return v;
}

interface MaterialProjectionPlan {
  readonly meshCount: number;
  readonly baseColor: readonly [number, number, number, number];
}

/**
 * Only project a flat, opaque material when Blender evidence proves that every
 * exported mesh uses the same single material. Roblox Studio has no trustworthy
 * per-face mapping in the current inspection contract, so varied materials are
 * rejected until that mapping can be projected and verified end to end.
 */
function buildMaterialProjectionPlan(
  exported: AssetFingerprint,
  fingerprintEvidence: unknown,
): MaterialProjectionPlan {
  const raw = fingerprintEvidence as {
    materials?: readonly {
      name?: unknown;
      hasTextures?: unknown;
      textureImages?: unknown;
      alpha?: unknown;
    }[];
    geometry?: {
      omittedMeshes?: unknown;
      meshes?: readonly {
        objectId?: unknown;
        faces?: unknown;
        unmappedFaces?: unknown;
        materialSlots?: readonly {
          objectId?: unknown;
          index?: unknown;
          materialName?: unknown;
          assignedFaces?: unknown;
        }[];
      }[];
    };
  } | null;

  if (!raw || !Array.isArray(raw.materials) || exported.materials.length !== 1) {
    throw new Error(
      "Roblox material projection currently supports one uniform exported material; multi-material and per-mesh-specific projection are unsupported",
    );
  }
  const material = exported.materials[0];
  const rawMaterial = raw.materials[0];
  if (
    !material ||
    !rawMaterial ||
    typeof material.name !== "string" ||
    material.name.length === 0 ||
    !material.baseColor ||
    material.baseColor.length !== 4 ||
    !material.baseColor.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
  ) {
    throw new Error("Exported material evidence must contain one explicit RGBA base color");
  }
  if (
    rawMaterial.hasTextures !== false ||
    (Array.isArray(rawMaterial.textureImages) && rawMaterial.textureImages.length > 0)
  ) {
    throw new Error(
      "Exported texture status is unknown or textured; Roblox texture/material projection is unsupported",
    );
  }
  if (typeof rawMaterial.alpha !== "number" || !Number.isFinite(rawMaterial.alpha)) {
    throw new Error("Exported material alpha evidence is unknown; refusing unsafe projection");
  }
  if (rawMaterial.alpha !== material.baseColor[3]) {
    throw new Error("Exported material alpha properties are inconsistent");
  }
  if (material.baseColor[3] !== 1) {
    throw new Error("Non-opaque material alpha cannot be projected safely to Roblox");
  }
  if (!Number.isInteger(exported.meshes) || exported.meshes <= 0) {
    throw new Error("Exported asset has no verifiable mesh geometry");
  }

  const meshes = raw.geometry?.meshes;
  if (
    !Array.isArray(meshes) ||
    meshes.length !== exported.meshes ||
    raw.geometry?.omittedMeshes !== 0
  ) {
    throw new Error("Per-mesh material-slot evidence is missing or does not match the export mesh count");
  }
  const meshIds = new Set<string>();
  for (const mesh of meshes) {
    if (
      !mesh ||
      typeof mesh.objectId !== "string" ||
      mesh.objectId.length === 0 ||
      meshIds.has(mesh.objectId) ||
      typeof mesh.faces !== "number" ||
      !Number.isInteger(mesh.faces) ||
      (mesh.faces as number) <= 0 ||
      mesh.unmappedFaces !== 0 ||
      !Array.isArray(mesh.materialSlots) ||
      mesh.materialSlots.length !== 1
    ) {
      throw new Error("Per-mesh material-slot mapping is ambiguous; only one material slot per mesh is supported");
    }
    meshIds.add(mesh.objectId);
    const slot = mesh.materialSlots[0];
    if (
      !slot ||
      slot.objectId !== mesh.objectId ||
      typeof slot.index !== "number" ||
      !Number.isInteger(slot.index) ||
      (slot.index as number) < 0 ||
      slot.index !== 0 ||
      slot.materialName !== material.name ||
      typeof slot.assignedFaces !== "number" ||
      !Number.isInteger(slot.assignedFaces) ||
      slot.assignedFaces !== mesh.faces
    ) {
      throw new Error("Export mesh is not mapped to the single verified material");
    }
  }

  return {
    meshCount: exported.meshes,
    baseColor: material.baseColor,
  };
}

function matchesBaseColor(
  colors: readonly (readonly number[])[],
  expected: readonly number[],
): boolean {
  return (
    colors.length > 0 &&
    colors.every(
      (color) =>
        color.length === expected.length &&
        color.every((value, index) => Math.abs(value - expected[index]) <= 1e-5),
    )
  );
}

function projectionErrorMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Verified material projection failed: ${detail}`;
}
export function makeRobloxServiceLayer(
  options: OpenCloudOptions & {
    onUploaded?: (artifactId: string, assetId: string) => Promise<void>;
    onImportIntent?: (asset: RobloxAssetRef) => Promise<void>;
    onInserted?: (asset: RobloxAssetRef, result: CallToolResult) => Promise<void>;
  },
) {
  return Layer.effect(
    RobloxService,
    Effect.gen(function* () {
      const broker = yield* StudioMcpBroker;
      const openCloud = new RobloxOpenCloudAssetService(options);
      const inspect = (asset: RobloxAssetRef) =>
        broker
          .callTool("execute_luau", {
            studio_id: asset.studioId,
            datamodel_type: "Edit",
            code: inspectionCode(asset.instanceName),
          })
          .pipe(
            Effect.flatMap((result) =>
              Effect.try(() => parseRobloxFingerprint(readStudioJson(result))),
            ),
          );
      return RobloxService.of({
        applyVerifiedMaterial: (asset, fingerprint) =>
          Effect.gen(function* () {
            const exported = yield* Schema.decodeUnknown(AssetFingerprintSchema)(fingerprint);
            const projection = yield* Effect.try({
              try: () => buildMaterialProjectionPlan(exported, fingerprint),
              catch: (cause) => cause,
            });
            const before = yield* inspect(asset);
            if (before.texturedParts !== 0)
              return yield* Effect.fail(
                new Error(
                  "Imported asset has appearance overlays; refusing to overwrite its appearance",
                ),
              );
            if (
              before.objects !== projection.meshCount ||
              before.meshParts !== projection.meshCount
            )
              return yield* Effect.fail(
                new Error(
                  "Imported mesh count does not match the verified export material mapping",
                ),
              );
            const result = yield* broker.callTool("execute_luau", {
              studio_id: asset.studioId,
              datamodel_type: "Edit",
              code: materialProjectionCode(
                asset.instanceName,
                projection.meshCount,
                projection.baseColor,
              ),
            });
            if (result.isError)
              return yield* Effect.fail(
                new Error("Studio rejected the explicit material projection"),
              );
            const receipt = yield* Effect.try({
              try: () =>
                readStudioJson(result) as { changedMeshes?: unknown; baseColor?: unknown },
              catch: (cause) => cause,
            });
            if (
              receipt.changedMeshes !== projection.meshCount ||
              !Array.isArray(receipt.baseColor) ||
              !matchesBaseColor([receipt.baseColor as number[]], projection.baseColor)
            )
              return yield* Effect.fail(
                new Error("Studio projection receipt does not match the export evidence"),
              );
            const after = yield* inspect(asset);
            if (
              after.objects !== projection.meshCount ||
              after.meshParts !== projection.meshCount ||
              after.texturedParts !== 0 ||
              !matchesBaseColor(after.colors, projection.baseColor)
            )
              return yield* Effect.fail(
                new Error("Post-projection inspection does not match the verified export material"),
              );
            return after;
          }).pipe(
            Effect.mapError(
              (cause) => new RobloxServiceError({ message: projectionErrorMessage(cause), cause }),
            ),
          ),
        importAsset: (artifact, studioId) =>
          Effect.gen(function* () {
            if (!artifact.path) return yield* Effect.fail(new Error("Import artifact has no path"));
            const discovery = yield* broker.callTool("list_roblox_studios", {});
            const studios = yield* Effect.try(
              () => readStudioJson(discovery) as { studios: { id: string }[] },
            );
            if (!studios.studios.some((studio) => studio.id === studioId))
              return yield* Effect.fail(new Error("Selected Studio is disconnected"));
            const state = yield* broker.callTool("get_studio_state", { studio_id: studioId });
            if (
              state.isError ||
              !state.content.some(
                (item) => item.type === "text" && item.text.includes("Current Studio Mode: Edit"),
              )
            )
              return yield* Effect.fail(new Error("Selected Studio must be in Edit mode"));
            const receipt = yield* Effect.tryPromise({
              try: () => openCloud.upload(artifact),
              catch: (cause) => cause,
            });
            const id = receipt.assetId;
            yield* Effect.tryPromise(async () => options.onUploaded?.(artifact.id, id));
            const asset = {
              id,
              studioId,
              instanceName: "BloxBot_" + randomUUID().replaceAll("-", "_"),
            };
            yield* Effect.tryPromise(async () => options.onImportIntent?.(asset));
            const result = yield* broker.callTool("insert_asset", {
              studio_id: studioId,
              assetId: id,
              assetName: asset.instanceName,
              assetType: "Model",
              parentPath: "Workspace",
            });
            if (result.isError)
              return yield* Effect.fail(new Error("Studio asset insertion failed"));
            yield* Effect.tryPromise(async () => options.onInserted?.(asset, result));
            yield* inspect(asset);
            return asset;
          }).pipe(
            Effect.mapError(
              (cause) => new RobloxServiceError({ message: "Roblox import failed", cause }),
            ),
          ),
        inspectAsset: (asset) =>
          inspect(asset).pipe(
            Effect.mapError(
              (cause) => new RobloxServiceError({ message: "Roblox inspection failed", cause }),
            ),
          ),
        captureEvidence: (jobId, asset, requirementIds) =>
          inspect(asset).pipe(
            Effect.map((value) =>
              requirementIds.map((requirementId) => ({
                id: randomUUID(),
                jobId,
                requirementId,
                source: "ROBLOX" as const,
                type: "asset.inspection",
                value,
                capturedAt: new Date().toISOString(),
              })),
            ),
            Effect.mapError(
              (cause) =>
                new RobloxServiceError({ message: "Roblox evidence capture failed", cause }),
            ),
          ),
      });
    }),
  );
}

/** Reapply the explicitly verified flat export color that Open Cloud drops. Idempotent. */
export function materialProjectionCode(
  instanceName: string,
  expectedMeshCount: number,
  baseColor: readonly [number, number, number, number],
): string {
  inspectionCode(instanceName); // Validate the generated identifier before interpolating it.
  if (!Number.isInteger(expectedMeshCount) || expectedMeshCount <= 0)
    throw new Error("Expected a positive exported mesh count");
  if (
    baseColor.length !== 4 ||
    !baseColor.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    baseColor[3] !== 1
  )
    throw new Error("Only explicit opaque RGBA export colors can be projected");
  const [r, g, b, a] = baseColor;
  return `
local matches = {}
for _, child in workspace:GetChildren() do
  if child.Name == "${instanceName}" then table.insert(matches, child) end
end
assert(#matches == 1 and matches[1]:IsA("Model"), "Expected the exact imported model")
local expectedMeshes = ${expectedMeshCount}
local expectedColor = Color3.new(${JSON.stringify(r)}, ${JSON.stringify(g)}, ${JSON.stringify(b)})
local changed = 0
for _, item in matches[1]:GetDescendants() do
  if item:IsA("MeshPart") then
    assert(item.TextureID == "", "Unexpected imported texture")
    assert(item.MaterialVariant == "", "Unexpected material variant")
    for _, child in item:GetDescendants() do
      assert(not child:IsA("SurfaceAppearance") and not child:IsA("Decal") and not child:IsA("Texture"), "Unexpected material overlay")
    end
    item.Color = expectedColor
    item.Transparency = ${JSON.stringify(1 - a)}
    changed += 1
  end
end
assert(changed == expectedMeshes, "Imported mesh/material mapping does not match the export")
return game:GetService("HttpService"):JSONEncode({changedMeshes=changed, baseColor={${JSON.stringify(r)},${JSON.stringify(g)},${JSON.stringify(b)},${JSON.stringify(a)}}})
`;
}
