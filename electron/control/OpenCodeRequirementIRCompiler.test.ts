import { describe, expect, it, vi } from "vitest";

import type { AssetFingerprint } from "../../src/types/asset";
import {
  DEFAULT_REQUIREMENT_IR_MODEL,
  OpenCodeRequirementIRCompiler,
  OPENCODE_REQUEST_TIMEOUT_MS,
  type OpenCodeRequirementIRClientFacade,
  type OpenCodeRequirementIRModel,
} from "./OpenCodeRequirementIRCompiler";
import { compileTask } from "./TaskCompiler";

const asset: AssetFingerprint = {
  assetId: "asset-1",
  format: "fbx",
  objects: 1,
  meshes: 1,
  vertices: 4,
  triangles: 2,
  materials: [],
  dimensions: { x: 1, y: 1, z: 1 },
  transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
  rig: { exists: false },
  topology: {},
  issues: [],
};

const structuredOutput = {
  requirements: [
    {
      id: "R_color",
      type: "material.base_color",
      target: "all_mesh_materials",
      expected: [0, 0, 0, 1],
      verification: "objective",
      mandatory: true,
    },
  ],
};

function makeClient(options: {
  structured?: unknown;
  promptError?: Error;
  deleteError?: Error;
} = {}) {
  type CreateParameters = Parameters<OpenCodeRequirementIRClientFacade["session"]["create"]>[0];
  type RequestOptions = Parameters<OpenCodeRequirementIRClientFacade["session"]["create"]>[1];
  type PromptParameters = Parameters<OpenCodeRequirementIRClientFacade["session"]["prompt"]>[0];
  type DeleteParameters = Parameters<OpenCodeRequirementIRClientFacade["session"]["delete"]>[0];
  const create = vi.fn(async (_parameters: CreateParameters, _options: RequestOptions) => ({ data: { id: "temporary-session" } }));
  const prompt = vi.fn(async (_parameters: PromptParameters, _options: RequestOptions) => {
    if (options.promptError) throw options.promptError;
    return { data: { info: { structured: options.structured ?? structuredOutput } } };
  });
  const remove = vi.fn(async (_parameters: DeleteParameters, _options: RequestOptions) => {
    if (options.deleteError) throw options.deleteError;
    return { data: true };
  });
  const client: OpenCodeRequirementIRClientFacade = {
    session: {
      create,
      prompt,
      delete: remove,
    },
  };
  return { client, create, prompt, remove };
}

async function compile(
  client: OpenCodeRequirementIRClientFacade,
  prompt = "Make the asset black.",
) {
  return new OpenCodeRequirementIRCompiler(client).compile({
    prompt,
    asset,
    maxRequirements: 32,
  });
}

describe("OpenCodeRequirementIRCompiler", () => {
  it("selects the default OpenCode Zen model and accepts an explicit override", async () => {
    const defaultClient = makeClient();
    await compile(defaultClient.client);
    expect(defaultClient.prompt.mock.calls[0][0].model).toEqual(DEFAULT_REQUIREMENT_IR_MODEL);

    const override: OpenCodeRequirementIRModel = {
      providerID: "example-provider",
      modelID: "trial-model",
    };
    const overrideClient = makeClient();
    await new OpenCodeRequirementIRCompiler(overrideClient.client, { model: override }).compile({
      prompt: "Make the asset black.",
      asset,
      maxRequirements: 32,
    });
    expect(overrideClient.prompt.mock.calls[0][0].model).toEqual(override);
    expect(overrideClient.create.mock.calls[0][0].model).toEqual({
      providerID: override.providerID,
      id: override.modelID,
    });
  });

  it("denies every tool on the temporary session and prompt", async () => {
    const { client, create, prompt } = makeClient();
    await compile(client);

    expect(create.mock.calls[0][0]).toMatchObject({
      model: { providerID: "opencode", id: "space-bunny-free" },
      metadata: { bloxbotHidden: true, purpose: "requirement-ir-compiler" },
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    expect(prompt.mock.calls[0][0].tools).toEqual({ "*": false });
  });

  it("requests the constrained Requirement IR JSON schema and returns only structured output", async () => {
    const { client, prompt } = makeClient();
    const result = await compile(client);

    const request = prompt.mock.calls[0][0];
    expect(request.format.type).toBe("json_schema");
    expect(request.format.retryCount).toBe(1);
    expect(request.format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["requirements"],
      properties: { requirements: { type: "array", minItems: 1, maxItems: 32 } },
    });
    const requirementSchema = request.format.schema.properties as Record<string, Record<string, unknown>>;
    const variants = (requirementSchema.requirements.items as { oneOf: Array<{ properties: Record<string, unknown> }> }).oneOf;
    expect(variants[0].properties.target).toEqual({ const: "all_mesh_materials" });
    expect(variants[0].properties.verification).toEqual({ const: "objective" });
    expect(variants[1].properties.target).toEqual({ const: "asset_bounding_box" });
    expect(variants[1].properties.verification).toEqual({ const: "objective" });
    expect(request.parts[0].text).toContain('"prompt":"Make the asset black."');
    expect(result).toBe(structuredOutput);
  });

  it("bounds every SDK request with a 60-second abort signal", async () => {
    const { client, create, prompt, remove } = makeClient();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await compile(client);
      expect(timeoutSpy).toHaveBeenCalledTimes(3);
      expect(timeoutSpy.mock.calls).toEqual([
        [OPENCODE_REQUEST_TIMEOUT_MS],
        [OPENCODE_REQUEST_TIMEOUT_MS],
        [OPENCODE_REQUEST_TIMEOUT_MS],
      ]);
      expect(prompt.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(remove.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("deletes the temporary session after a successful prompt", async () => {
    const { client, remove } = makeClient();
    await compile(client);
    expect(remove).toHaveBeenCalledWith(
      { sessionID: "temporary-session" },
      expect.objectContaining({ throwOnError: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("deletes the temporary session after prompt failure and preserves that failure", async () => {
    const failure = new Error("model request failed");
    const { client, remove } = makeClient({ promptError: failure });

    await expect(compile(client)).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith(
      { sessionID: "temporary-session" },
      expect.objectContaining({ throwOnError: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps successful structured output when best-effort cleanup fails", async () => {
    const { client, remove } = makeClient({ deleteError: new Error("delete failed") });

    await expect(compile(client)).resolves.toBe(structuredOutput);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("passes model output through TaskCompiler's validated lowering boundary", async () => {
    const blueGray = {
      requirements: [
        {
          id: "R_color",
          type: "material.base_color",
          target: "all_mesh_materials",
          expected: [0.1, 0.2, 0.3, 1],
          verification: "objective",
          mandatory: true,
        },
      ],
    };
    const { client } = makeClient({ structured: blueGray });

    const result = await compileTask(
      "Make every material blue-gray.",
      asset,
      new OpenCodeRequirementIRCompiler(client),
    );

    expect(result?.requirements).toEqual([
      {
        id: "R_color",
        type: "material.base_color",
        target: "all_mesh_materials",
        expected: [0.1, 0.2, 0.3, 1],
        mandatory: true,
        status: "PENDING",
      },
    ]);
    expect(result?.evaluations).toEqual([
      {
        requirementId: "R_color",
        method: "material_property",
        expected: [0.1, 0.2, 0.3, 1],
      },
    ]);
  });
});

