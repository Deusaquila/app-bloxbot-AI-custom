import { randomUUID } from "node:crypto";

import type { AssetFingerprint } from "../../src/types/asset";
import type { Requirement, RequirementIR } from "../../src/types/job";
import type { EvaluationSpec } from "../../src/types/evaluation";
import {
  decodeRequirementCompilerOutput,
  InvalidRequirementCompilerOutput,
  MAX_REQUIREMENTS,
} from "./RequirementIR";

export interface CompiledTask {
  requirementIR: readonly RequirementIR[];
  requirements: Requirement[];
  evaluations: EvaluationSpec[];
}

export interface RequirementIRCompiler {
  /** Return structured Requirement IR only; implementations receive no JobService or executor. */
  compile(input: {
    prompt: string;
    asset: AssetFingerprint;
    maxRequirements: typeof MAX_REQUIREMENTS;
  }): Promise<unknown>;
}

const MAX_FALLBACK_PROMPT_LENGTH = 8_000;
const MAX_FALLBACK_INPUT_LENGTH = 32_000;

/** Validate compiler output, then lower only currently supported objective requirements. */
export function compileRequirementOutput(candidate: unknown): CompiledTask {
  const requirementIR = decodeRequirementCompilerOutput(candidate);
  const requirements: Requirement[] = [];
  const evaluations: EvaluationSpec[] = [];

  for (const requirement of requirementIR) {
    if (requirement.verification !== "objective") {
      throw new InvalidRequirementCompilerOutput(
        `Semantic verification is not available for ${requirement.type}`,
      );
    }

    if (requirement.type === "material.base_color") {
      if (requirement.target !== "all_mesh_materials") {
        throw new InvalidRequirementCompilerOutput(
          `Material target is not executable by the current capability: ${JSON.stringify(requirement.target)}`,
        );
      }
      requirements.push({
        id: requirement.id,
        type: requirement.type,
        target: requirement.target,
        expected: requirement.expected,
        mandatory: requirement.mandatory,
        status: "PENDING",
      });
      evaluations.push({
        requirementId: requirement.id,
        method: "material_property",
        expected: requirement.expected,
      });
      continue;
    }

    if (requirement.type === "geometry.relative_size") {
      requirements.push({
        id: requirement.id,
        type: requirement.type,
        target: requirement.target,
        expected: requirement.expected,
        mandatory: requirement.mandatory,
        status: "PENDING",
      });
      evaluations.push({
        requirementId: requirement.id,
        method: "relative_bounding_box",
        expected: requirement.expected,
        ...(requirement.tolerance === undefined ? {} : { tolerance: requirement.tolerance }),
      });
    }
  }

  return { requirementIR, requirements, evaluations };
}

export function compileKnownV1Task(prompt: string, _asset: AssetFingerprint): CompiledTask | undefined {
  const normalized = prompt.toLocaleLowerCase("sv-SE");
  // Only known complete instructions are accepted; never silently ignore a negation or extra task.
  const supported = new Set([
    "gör den svart och dubbelt så stor", "make it black and twice as large", "make it black and double the size",
  ]);
  if (!supported.has(normalized.trim().replace(/[.!]+$/, ""))) return undefined;
  const requirements: RequirementIR[] = [];

  if (normalized.includes("svart") || normalized.includes("black")) {
    requirements.push({
      id: randomUUID(),
      type: "material.base_color",
      target: "all_mesh_materials",
      expected: [0, 0, 0, 1],
      verification: "objective",
      mandatory: true,
    });
  }

  if (
    normalized.includes("dubbelt så stor") ||
    normalized.includes("dubbla storleken") ||
    normalized.includes("twice as large") ||
    normalized.includes("double the size")
  ) {
    requirements.push({
      id: randomUUID(),
      type: "geometry.relative_size",
      target: "asset_bounding_box",
      expected: 2,
      verification: "objective",
      mandatory: true,
      tolerance: 0.01,
    });
  }

  return requirements.length > 0 ? compileRequirementOutput({ requirements }) : undefined;
}

/**
 * Deterministic fast path first, with an optional reasoning adapter that can
 * return only validated Requirement IR and cannot manipulate job state.
 * Schema validity does not prove that reasoning output captured every prompt
 * constraint; keep this fallback out of the live V1 runner until that semantic
 * completeness gap has its own validation.
 */
export async function compileTask(
  prompt: string,
  asset: AssetFingerprint,
  fallback?: RequirementIRCompiler,
): Promise<CompiledTask | undefined> {
  const known = compileKnownV1Task(prompt, asset);
  if (known || !fallback) return known;
  if (prompt.length > MAX_FALLBACK_PROMPT_LENGTH) {
    throw new InvalidRequirementCompilerOutput("Prompt exceeds the compiler input limit");
  }

  let serializedInput: string;
  try {
    const serialized = JSON.stringify({ prompt, asset });
    if (serialized === undefined) {
      throw new Error("Compiler input serialization returned no data");
    }
    serializedInput = serialized;
  } catch {
    throw new InvalidRequirementCompilerOutput("Asset fingerprint is not serializable for compilation");
  }
  if (serializedInput.length > MAX_FALLBACK_INPUT_LENGTH) {
    throw new InvalidRequirementCompilerOutput("Prompt and asset fingerprint exceed the compiler input limit");
  }

  const snapshot = JSON.parse(serializedInput) as { prompt: string; asset: AssetFingerprint };
  const candidate = await fallback.compile({
    ...snapshot,
    maxRequirements: MAX_REQUIREMENTS,
  });
  return compileRequirementOutput(candidate);
}
