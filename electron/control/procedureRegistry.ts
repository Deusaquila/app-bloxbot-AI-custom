import { Effect, Schema } from "effect";
import { ArtifactSchema } from "../../src/types/job";
import type { BlenderServiceApi } from "../services/BlenderService";
import type { RobloxServiceApi } from "../services/RobloxService";
import {
  type CapabilityDefinition,
  type CapabilityExecutor,
  type CapabilityId,
  V1_CAPABILITIES,
} from "./capabilityRegistry";

export interface ProcedureServices {
  readonly blender: BlenderServiceApi;
  readonly roblox: RobloxServiceApi;
}

/** A versioned implementation of one capability. Selection policy is deliberately separate. */
export interface ProcedureDefinition {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly version: number;
  readonly executor: CapabilityExecutor;
  readonly invoke: (services: ProcedureServices, input: unknown) => Effect.Effect<unknown, unknown>;
}

export interface ProcedureRegistryApi {
  readonly procedures: readonly ProcedureDefinition[];
  readonly resolve: (capability: string) => ProcedureDefinition | undefined;
}

export function createProcedureRegistry(
  definitions: readonly ProcedureDefinition[],
): ProcedureRegistryApi {
  const byCapability = new Map<string, ProcedureDefinition>();
  const procedureIds = new Set<string>();

  for (const procedure of definitions) {
    if (procedureIds.has(procedure.id)) throw new Error(`Duplicate procedure id: ${procedure.id}`);
    if (byCapability.has(procedure.capability))
      throw new Error(
        `Multiple procedures for ${procedure.capability} need an explicit selection policy`,
      );
    procedureIds.add(procedure.id);
    byCapability.set(procedure.capability, procedure);
  }

  const procedures = Object.freeze([...definitions]);
  return Object.freeze({
    procedures,
    resolve: (capability: string) => byCapability.get(capability),
  });
}

export function assertProcedureCoverage(
  registry: ProcedureRegistryApi,
  capabilities: readonly CapabilityDefinition[] = V1_CAPABILITIES,
): void {
  for (const capability of capabilities) {
    const procedure = registry.resolve(capability.id);
    if (!procedure) throw new Error(`No procedure registered for capability ${capability.id}`);
    if (procedure.executor !== capability.executor)
      throw new Error(`Procedure executor mismatch for capability ${capability.id}`);
  }
  if (registry.procedures.length !== capabilities.length)
    throw new Error("Procedure registry contains a capability outside the declared catalog");
}

function blenderProcedure(capability: CapabilityDefinition): ProcedureDefinition {
  return {
    id: `blender:${capability.id}:v1`,
    capability: capability.id,
    version: 1,
    executor: "BLENDER",
    invoke: (services, input) => services.blender.executeCapability(capability.id, input),
  };
}

const RobloxAssetRefSchema = Schema.Struct({
  id: Schema.String,
  studioId: Schema.String,
  instanceName: Schema.String,
});

const RobloxImportInputSchema = Schema.Struct({
  artifact: ArtifactSchema,
  studioId: Schema.String,
});

const RobloxInspectInputSchema = Schema.Struct({ asset: RobloxAssetRefSchema });

const RobloxMaterialInputSchema = Schema.Struct({
  asset: RobloxAssetRefSchema,
  fingerprint: Schema.Unknown,
});

const robloxProcedures: readonly ProcedureDefinition[] = [
  {
    id: "roblox:import_asset:v1",
    capability: "roblox.import_asset",
    version: 1,
    executor: "ROBLOX",
    invoke: (services, input) =>
      Schema.decodeUnknown(RobloxImportInputSchema)(input).pipe(
        Effect.flatMap(({ artifact, studioId }) => services.roblox.importAsset(artifact, studioId)),
      ),
  },
  {
    id: "roblox:inspect_asset:v1",
    capability: "roblox.inspect_asset",
    version: 1,
    executor: "ROBLOX",
    invoke: (services, input) =>
      Schema.decodeUnknown(RobloxInspectInputSchema)(input).pipe(
        Effect.flatMap(({ asset }) => services.roblox.inspectAsset(asset)),
      ),
  },
  {
    id: "roblox:apply_verified_material:v1",
    capability: "roblox.apply_verified_material",
    version: 1,
    executor: "ROBLOX",
    invoke: (services, input) =>
      Schema.decodeUnknown(RobloxMaterialInputSchema)(input).pipe(
        Effect.flatMap(({ asset, fingerprint }) =>
          services.roblox.applyVerifiedMaterial(asset, fingerprint),
        ),
      ),
  },
];

const blenderProcedures = V1_CAPABILITIES.filter(
  (capability) => capability.executor === "BLENDER",
).map(blenderProcedure);

export const V1_PROCEDURES: readonly ProcedureDefinition[] = Object.freeze([
  ...blenderProcedures,
  ...robloxProcedures,
]);

export const V1_PROCEDURE_REGISTRY = createProcedureRegistry(V1_PROCEDURES);
assertProcedureCoverage(V1_PROCEDURE_REGISTRY);
