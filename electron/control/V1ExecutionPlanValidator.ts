import { Schema } from "effect";

import { findCapability, type CapabilityId } from "./capabilityRegistry";
import {
  ExecutionPlanSchema,
  RequirementSchema,
  type ExecutionOperation,
  type ExecutionPlan,
  type Requirement,
} from "../../src/types/job";

const MAX_REQUIREMENTS = 32;

export class InvalidV1ExecutionPlan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidV1ExecutionPlan";
  }
}

export interface RequirementExecutionMapping {
  mutationCapability: CapabilityId;
  verificationCapability: CapabilityId;
}

function fail(message: string): never {
  throw new InvalidV1ExecutionPlan(message);
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

export function mapV1Requirement(requirement: Requirement): RequirementExecutionMapping {
  if (requirement.type === "material.base_color") {
    if (requirement.target !== "all_mesh_materials") {
      return fail(`Unsupported target for requirement ${requirement.id}: material.base_color`);
    }
    if (
      !Array.isArray(requirement.expected) ||
      requirement.expected.length !== 4 ||
      requirement.expected.some(
        (channel) => typeof channel !== "number" || !Number.isFinite(channel) || channel < 0 || channel > 1,
      )
    ) {
      return fail(`Invalid RGBA expectation for requirement ${requirement.id}`);
    }
    return {
      mutationCapability: "material.set_base_color",
      verificationCapability: "asset.verify_material",
    };
  }

  if (requirement.type === "geometry.relative_size") {
    if (requirement.target !== "asset_bounding_box") {
      return fail(`Unsupported target for requirement ${requirement.id}: geometry.relative_size`);
    }
    if (
      typeof requirement.expected !== "number" ||
      !Number.isFinite(requirement.expected) ||
      requirement.expected <= 0
    ) {
      return fail(`Invalid relative size expectation for requirement ${requirement.id}`);
    }
    return {
      mutationCapability: "transform.scale_uniform",
      verificationCapability: "asset.verify_dimensions",
    };
  }

  return fail(`No V1 capability and verifier are registered for requirement ${requirement.type}`);
}

function validateRequirements(candidate: readonly Requirement[]): readonly Requirement[] {
  const decoded = Schema.decodeUnknownEither(Schema.Array(RequirementSchema))(candidate);
  if (decoded._tag === "Left") {
    return fail(`Requirements failed schema validation: ${String(decoded.left)}`);
  }
  const requirements = decoded.right;
  if (requirements.length === 0 || requirements.length > MAX_REQUIREMENTS) {
    return fail(`V1 planning requires between 1 and ${MAX_REQUIREMENTS} requirements`);
  }

  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) return fail(`Duplicate requirement id: ${requirement.id}`);
    ids.add(requirement.id);
    mapV1Requirement(requirement);
  }
  return requirements;
}

function validateDag(operations: readonly ExecutionOperation[]): void {
  const byId = new Map<string, ExecutionOperation>();
  for (const operation of operations) {
    if (byId.has(operation.id)) return fail(`Duplicate operation id: ${operation.id}`);
    byId.set(operation.id, operation);

    const capability = findCapability(operation.capability);
    if (!capability) return fail(`Unknown capability: ${operation.capability}`);
    if (operation.executor !== capability.executor) {
      return fail(`Executor does not match capability ${operation.capability}`);
    }
    if (operation.status !== "PENDING" || operation.attempts !== 0) {
      return fail(`New execution plan operation ${operation.id} must be pending with zero attempts`);
    }

    if (new Set(operation.dependsOn).size !== operation.dependsOn.length) {
      return fail(`Operation ${operation.id} has duplicate dependencies`);
    }
    if (new Set(operation.requirementIds).size !== operation.requirementIds.length) {
      return fail(`Operation ${operation.id} has duplicate requirement links`);
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const operation of operations) {
    indegree.set(operation.id, operation.dependsOn.length);
    for (const dependencyId of operation.dependsOn) {
      if (!byId.has(dependencyId)) {
        return fail(`Operation ${operation.id} depends on missing operation ${dependencyId}`);
      }
      if (dependencyId === operation.id) return fail(`Operation ${operation.id} depends on itself`);
      children.set(dependencyId, [...(children.get(dependencyId) ?? []), operation.id]);
    }
  }

  const ready = operations.filter((operation) => indegree.get(operation.id) === 0).map((op) => op.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited += 1;
    for (const childId of children.get(id) ?? []) {
      const next = indegree.get(childId)! - 1;
      indegree.set(childId, next);
      if (next === 0) ready.push(childId);
    }
  }
  if (visited !== operations.length) return fail("Execution plan contains a dependency cycle");
}

function requireSingleCapability(
  operations: readonly ExecutionOperation[],
  capability: string,
): ExecutionOperation {
  const matches = operations.filter((operation) => operation.capability === capability);
  if (matches.length !== 1) {
    return fail(`Expected exactly one ${capability} operation, received ${matches.length}`);
  }
  return matches[0];
}

function operationHasOnlyExpectedInput(operation: ExecutionOperation, expected: unknown): boolean {
  if (expected === undefined) return hasExactKeys(operation.input, []);
  return hasExactKeys(operation.input, ["expected"]) && equalJson(operation.input.expected, expected);
}

/** Validate requirement typing, DAG integrity, and complete execution/verification coverage. */
export function validateV1ExecutionPlan(
  candidateRequirements: readonly Requirement[],
  candidatePlan: unknown,
): ExecutionPlan {
  const requirements = validateRequirements(candidateRequirements);
  const decodedPlan = Schema.decodeUnknownEither(ExecutionPlanSchema)(candidatePlan);
  if (decodedPlan._tag === "Left") {
    return fail(`Execution plan failed schema validation: ${String(decodedPlan.left)}`);
  }
  const plan = decodedPlan.right;
  const operations = plan.operations;
  if (operations.length === 0) return fail("Execution plan has no operations");
  if (operations.length > 2 + requirements.length * 2) {
    return fail("Execution plan contains more operations than this V1 planner supports");
  }

  validateDag(operations);
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  for (const operation of operations) {
    for (const requirementId of operation.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        return fail(`Operation ${operation.id} references unknown requirement ${requirementId}`);
      }
    }
    if (operation.result !== undefined || operation.error !== undefined) {
      return fail(`New execution plan operation ${operation.id} cannot contain a result or error`);
    }
  }

  if (operations.length !== 2 + requirements.length * 2) {
    return fail("Execution plan contains missing or unsupported operations");
  }
  const inspect = requireSingleCapability(operations, "asset.inspect");
  const exportFbx = requireSingleCapability(operations, "asset.export_fbx");
  if (
    inspect.requirementIds.length !== 0 ||
    inspect.dependsOn.length !== 0 ||
    !operationHasOnlyExpectedInput(inspect, undefined)
  ) {
    return fail("asset.inspect must be a root operation with no requirement links or input");
  }

  const expectedExportRequirements = [...requirementIds].sort();
  if (
    !equalJson([...exportFbx.requirementIds].sort(), expectedExportRequirements) ||
    !equalJson([...exportFbx.dependsOn].sort(),
      operations
        .filter((operation) => operation.capability === "asset.verify_material" || operation.capability === "asset.verify_dimensions")
        .map((operation) => operation.id)
        .sort(),
    ) ||
    !operationHasOnlyExpectedInput(exportFbx, undefined)
  ) {
    return fail("asset.export_fbx must join all requirement verifiers and carry every requirement");
  }

  for (const requirement of requirements) {
    const mapping = mapV1Requirement(requirement);
    const mutations = operations.filter(
      (operation) =>
        operation.capability === mapping.mutationCapability &&
        operation.requirementIds.includes(requirement.id),
    );
    const verifiers = operations.filter(
      (operation) =>
        operation.capability === mapping.verificationCapability &&
        operation.requirementIds.includes(requirement.id),
    );
    if (mutations.length !== 1 || verifiers.length !== 1) {
      return fail(`Requirement ${requirement.id} must have exactly one mutation and one verifier`);
    }
    const mutation = mutations[0];
    const verifier = verifiers[0];
    if (
      mutation.requirementIds.length !== 1 ||
      verifier.requirementIds.length !== 1 ||
      !equalJson(mutation.dependsOn, [inspect.id]) ||
      !equalJson(verifier.dependsOn, [mutation.id]) ||
      !operationHasOnlyExpectedInput(mutation, requirement.expected) ||
      !operationHasOnlyExpectedInput(verifier, requirement.expected)
    ) {
      return fail(`Requirement ${requirement.id} has invalid operation links or expected values`);
    }
  }

  return plan;
}
