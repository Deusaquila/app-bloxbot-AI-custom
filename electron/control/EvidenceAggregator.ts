import { randomUUID } from "node:crypto";

import type { Evidence, EvidenceSource } from "../../src/types/job";

export interface EvidenceInput {
  jobId: string;
  requirementId?: string;
  source: EvidenceSource;
  type: string;
  value: unknown;
}

export function createEvidence(input: EvidenceInput): Evidence {
  return {
    id: randomUUID(),
    jobId: input.jobId,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    source: input.source,
    type: input.type,
    value: input.value,
    capturedAt: new Date().toISOString(),
  };
}

export function evidenceForRequirement(
  evidence: readonly Evidence[],
  requirementId: string,
): readonly Evidence[] {
  return evidence.filter((item) => item.requirementId === requirementId);
}
