import { Schema } from "effect";

import {
  RequirementIRSchema,
  type RequirementIR,
} from "../../src/types/job";

export const MAX_REQUIREMENTS = 32;
const MAX_TARGET_IDS = 256;
const IdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OutputSchema = Schema.Struct({ requirements: Schema.Array(RequirementIRSchema) });

export class InvalidRequirementCompilerOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequirementCompilerOutput";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactTargetShape(requirement: Record<string, unknown>): boolean {
  const target = requirement.target;
  if (typeof target === "string") return true;
  if (!isPlainRecord(target)) return false;
  return hasOnlyKeys(target, ["kind", "ids"]);
}

function hasStrictOutputShape(candidate: unknown): candidate is Record<string, unknown> {
  if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, ["requirements"])) return false;
  if (!Array.isArray(candidate.requirements) || candidate.requirements.length > MAX_REQUIREMENTS)
    return false;

  for (const value of candidate.requirements) {
    if (!isPlainRecord(value)) return false;
    const allowed =
      value.type === "geometry.relative_size"
        ? ["id", "type", "target", "expected", "verification", "mandatory", "tolerance"]
        : ["id", "type", "target", "expected", "verification", "mandatory"];
    if (!hasOnlyKeys(value, allowed) || !hasExactTargetShape(value)) return false;
    if (isPlainRecord(value.target) && Array.isArray(value.target.ids)) {
      if (value.target.ids.length > MAX_TARGET_IDS) return false;
    }
  }
  return true;
}

/**
 * Decode untrusted compiler/LLM output into the constrained Requirement IR.
 * Unknown fields are rejected so an LLM cannot smuggle execution instructions
 * alongside requirements.
 */
export function decodeRequirementCompilerOutput(candidate: unknown): readonly RequirementIR[] {
  if (!hasStrictOutputShape(candidate)) {
    throw new InvalidRequirementCompilerOutput("Compiler output has an invalid or oversized shape");
  }

  const decoded = Schema.decodeUnknownEither(OutputSchema)(candidate);
  if (decoded._tag === "Left") {
    throw new InvalidRequirementCompilerOutput(`Compiler requirements failed schema validation: ${String(decoded.left)}`);
  }
  const requirements = decoded.right.requirements;
  if (requirements.length === 0) {
    throw new InvalidRequirementCompilerOutput("Compiler output must contain at least one requirement");
  }

  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.mandatory) {
      throw new InvalidRequirementCompilerOutput("Compiler may not downgrade a requirement to optional");
    }
    if (!IdentifierPattern.test(requirement.id)) {
      throw new InvalidRequirementCompilerOutput(`Invalid requirement id: ${requirement.id}`);
    }
    if (ids.has(requirement.id)) {
      throw new InvalidRequirementCompilerOutput(`Duplicate requirement id: ${requirement.id}`);
    }
    ids.add(requirement.id);

    if (requirement.type === "material.base_color" && typeof requirement.target !== "string") {
      const targetIds = requirement.target.ids;
      if (targetIds.length === 0 || new Set(targetIds).size !== targetIds.length) {
        throw new InvalidRequirementCompilerOutput("Material target ids must be non-empty and unique");
      }
      if (targetIds.some((id) => !IdentifierPattern.test(id))) {
        throw new InvalidRequirementCompilerOutput("Material target contains an invalid id");
      }
    }
  }

  return requirements;
}
