import { randomUUID } from "node:crypto";
import { AssetFingerprintSchema } from "../../src/types/asset";
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
local parts, colors, textured = {}, {}, 0
local lo, hi = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
for _, item in root:GetDescendants() do
  assert(not item:IsA("LuaSourceContainer"), "Imported geometry contains scripts")
  if item:IsA("BasePart") and not (item.ClassName == "Part" and item.Name == "RootPart" and item.Transparency == 1) then
    table.insert(parts, item)
    table.insert(colors, {item.Color.R, item.Color.G, item.Color.B, 1-item.Transparency})
    local hasTexture = item:IsA("MeshPart") and item.TextureID ~= ""
    for _, child in item:GetDescendants() do
      if child:IsA("SurfaceAppearance") or child:IsA("Texture") or child:IsA("Decal") then hasTexture = true end
    end
    if hasTexture then textured += 1 end
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
 texturedParts=textured, dimensions={x=d.X,y=d.Y,z=d.Z}, hierarchyValid=root.Parent==workspace})
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
            if (
              !exported.materials.length ||
              !exported.materials.every(
                (m) =>
                  m.baseColor?.length === 4 &&
                  m.baseColor.every((n, i) => Math.abs(n - [0, 0, 0, 1][i]) <= 1e-5),
              )
            )
              return yield* Effect.fail(new Error("Uniform black export evidence is required"));
            const before = yield* inspect(asset);
            if (before.texturedParts !== 0 || before.objects !== exported.meshes)
              return yield* Effect.fail(
                new Error("Imported mesh/material structure differs from the export"),
              );
            const result = yield* broker.callTool("execute_luau", {
              studio_id: asset.studioId,
              datamodel_type: "Edit",
              code: materialProjectionCode(asset.instanceName),
            });
            if (result.isError)
              return yield* Effect.fail(new Error("Verified material projection failed"));
            return yield* inspect(asset);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new RobloxServiceError({ message: "Verified material projection failed", cause }),
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

/** Reapply the verified uniform export material that Open Cloud drops. Idempotent. */
export function materialProjectionCode(instanceName: string): string {
  inspectionCode(instanceName); // Validate the generated identifier before interpolating it.
  return `
local matches = {}
for _, child in workspace:GetChildren() do
  if child.Name == "${instanceName}" then table.insert(matches, child) end
end
assert(#matches == 1 and matches[1]:IsA("Model"), "Expected the exact imported model")
local changed = 0
for _, item in matches[1]:GetDescendants() do
  if item:IsA("MeshPart") then
    assert(item.TextureID == "", "Unexpected imported texture")
    for _, child in item:GetDescendants() do
      assert(not child:IsA("SurfaceAppearance") and not child:IsA("Decal") and not child:IsA("Texture"), "Unexpected material overlay")
    end
    item.Color = Color3.new(0, 0, 0)
    item.Transparency = 0
    item.Material = Enum.Material.SmoothPlastic
    item.MaterialVariant = ""
    changed += 1
  end
end
assert(changed > 0, "No imported mesh geometry")
return game:GetService("HttpService"):JSONEncode({changedMeshes=changed, color={0,0,0,1}})
`;
}
