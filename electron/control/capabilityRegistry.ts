import { Schema } from "effect";

export const CapabilityExecutorSchema = Schema.Literal("BLENDER", "ROBLOX", "SYSTEM");
export type CapabilityExecutor = typeof CapabilityExecutorSchema.Type;

export const CapabilityIdSchema = Schema.Literal(
  "asset.inspect",
  "material.set_base_color",
  "transform.scale_uniform",
  "asset.verify_material",
  "asset.verify_dimensions",
  "asset.export_fbx",
  "roblox.import_asset",
  "roblox.inspect_asset",
  "roblox.apply_verified_material",
);
export type CapabilityId = typeof CapabilityIdSchema.Type;

export interface CapabilityDefinition {
  id: CapabilityId;
  executor: CapabilityExecutor;
}

export const V1_CAPABILITIES: readonly CapabilityDefinition[] = [
  { id: "asset.inspect", executor: "BLENDER" },
  { id: "material.set_base_color", executor: "BLENDER" },
  { id: "transform.scale_uniform", executor: "BLENDER" },
  { id: "asset.verify_material", executor: "BLENDER" },
  { id: "asset.verify_dimensions", executor: "BLENDER" },
  { id: "asset.export_fbx", executor: "BLENDER" },
  { id: "roblox.import_asset", executor: "ROBLOX" },
  { id: "roblox.inspect_asset", executor: "ROBLOX" },
  { id: "roblox.apply_verified_material", executor: "ROBLOX" },
];

export function findCapability(id: string): CapabilityDefinition | undefined {
  return V1_CAPABILITIES.find((capability) => capability.id === id);
}
