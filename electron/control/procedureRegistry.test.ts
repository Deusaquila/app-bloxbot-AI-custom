import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../../src/types/job";
import type { BlenderServiceApi } from "../services/BlenderService";
import type {
  RobloxAssetFingerprint,
  RobloxAssetRef,
  RobloxServiceApi,
} from "../services/RobloxService";
import { V1_CAPABILITIES } from "./capabilityRegistry";
import {
  assertProcedureCoverage,
  createProcedureRegistry,
  type ProcedureServices,
  V1_PROCEDURE_REGISTRY,
  V1_PROCEDURES,
} from "./procedureRegistry";

const artifact: Artifact = {
  id: "artifact-1",
  jobId: "job-1",
  type: "EXPORTED_FBX",
  path: "C:/work/output.fbx",
  createdAt: "2026-09-26T00:00:00.000Z",
};

const asset: RobloxAssetRef = {
  id: "123456789",
  studioId: "studio-1",
  instanceName: "BloxBot_test",
};

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a registered test value");
  return value;
}

function makeServices(calls: unknown[]): ProcedureServices {
  const blender = {
    executeCapability: (capability: string, input: unknown) =>
      Effect.sync(() => {
        calls.push({ service: "BLENDER", capability, input });
        return { status: "SUCCEEDED" as const, value: { capability } };
      }),
  } as unknown as BlenderServiceApi;

  const fingerprint: RobloxAssetFingerprint = {
    objects: 1,
    materials: 1,
    dimensions: { x: 1, y: 2, z: 3 },
    hierarchyValid: true,
    colors: [[0, 0, 0, 1]],
    texturedParts: 0,
  };
  const roblox = {
    importAsset: (value: Artifact, studioId: string) =>
      Effect.sync(() => {
        calls.push({ service: "ROBLOX", capability: "roblox.import_asset", value, studioId });
        return asset;
      }),
    inspectAsset: (value: RobloxAssetRef) =>
      Effect.sync(() => {
        calls.push({ service: "ROBLOX", capability: "roblox.inspect_asset", value });
        return fingerprint;
      }),
    applyVerifiedMaterial: (value: RobloxAssetRef, evidence: unknown) =>
      Effect.sync(() => {
        calls.push({
          service: "ROBLOX",
          capability: "roblox.apply_verified_material",
          value,
          evidence,
        });
        return fingerprint;
      }),
  } as unknown as RobloxServiceApi;

  return { blender, roblox };
}

describe("deterministic procedure registry", () => {
  it("registers one versioned implementation for every V1 capability", () => {
    expect(V1_PROCEDURE_REGISTRY.procedures).toHaveLength(V1_CAPABILITIES.length);
    expect(new Set(V1_PROCEDURES.map((procedure) => procedure.capability)).size).toBe(
      V1_CAPABILITIES.length,
    );
    expect(new Set(V1_PROCEDURES.map((procedure) => procedure.id)).size).toBe(V1_PROCEDURES.length);
    expect(V1_PROCEDURES.every((procedure) => procedure.version === 1)).toBe(true);
    expect(() => assertProcedureCoverage(V1_PROCEDURE_REGISTRY)).not.toThrow();
  });

  it("rejects duplicate procedures until a selection policy exists", () => {
    const first = requireValue(V1_PROCEDURES[0]);
    expect(() =>
      createProcedureRegistry([first, { ...first, id: `${first.id}:alternate` }]),
    ).toThrow(/explicit selection policy/);
    expect(() =>
      createProcedureRegistry([first, { ...requireValue(V1_PROCEDURES[1]), id: first.id }]),
    ).toThrow(/Duplicate procedure id/);
  });

  it("requires complete capability and executor coverage", () => {
    expect(() => assertProcedureCoverage(createProcedureRegistry(V1_PROCEDURES.slice(1)))).toThrow(
      /No procedure registered/,
    );

    const first = requireValue(V1_PROCEDURES[0]);
    const mismatched = createProcedureRegistry([
      { ...first, executor: first.executor === "BLENDER" ? "ROBLOX" : "BLENDER" },
      ...V1_PROCEDURES.slice(1),
    ]);
    expect(() => assertProcedureCoverage(mismatched)).toThrow(/executor mismatch/);
  });

  it("delegates each Blender procedure to the Blender adapter with its input unchanged", async () => {
    const calls: unknown[] = [];
    const services = makeServices(calls);
    const input = { expected: [0, 0, 0, 1], operationId: "operation-1" };
    const procedures = V1_PROCEDURES.filter((procedure) => procedure.executor === "BLENDER");

    for (const procedure of procedures) await Effect.runPromise(procedure.invoke(services, input));

    expect(calls).toEqual(
      procedures.map((procedure) => ({
        service: "BLENDER",
        capability: procedure.capability,
        input,
      })),
    );
  });

  it("runs the explicit Roblox implementations and validates their inputs", async () => {
    const calls: unknown[] = [];
    const services = makeServices(calls);
    const importProcedure = requireValue(V1_PROCEDURE_REGISTRY.resolve("roblox.import_asset"));
    const inspectProcedure = requireValue(V1_PROCEDURE_REGISTRY.resolve("roblox.inspect_asset"));
    const materialProcedure = requireValue(
      V1_PROCEDURE_REGISTRY.resolve("roblox.apply_verified_material"),
    );
    const evidence = { materials: [{ baseColor: [0, 0, 0, 1] }] };

    await expect(
      Effect.runPromise(importProcedure.invoke(services, { artifact, studioId: asset.studioId })),
    ).resolves.toEqual(asset);
    await Effect.runPromise(inspectProcedure.invoke(services, { asset }));
    await Effect.runPromise(materialProcedure.invoke(services, { asset, fingerprint: evidence }));

    expect(calls).toEqual([
      {
        service: "ROBLOX",
        capability: "roblox.import_asset",
        value: artifact,
        studioId: asset.studioId,
      },
      { service: "ROBLOX", capability: "roblox.inspect_asset", value: asset },
      {
        service: "ROBLOX",
        capability: "roblox.apply_verified_material",
        value: asset,
        evidence,
      },
    ]);

    await expect(
      Effect.runPromise(importProcedure.invoke(services, { artifact: {}, studioId: "" })),
    ).rejects.toThrow();
  });
});
