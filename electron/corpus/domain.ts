export const CORPUS_STAGES = [
  "discovery",
  "metadata",
  "download",
  "hash",
  "conversion",
  "inspection",
  "classification",
  "complete",
] as const;

export type CorpusStage = (typeof CORPUS_STAGES)[number];

export const CORPUS_STATUSES = ["pending", "in_progress", "succeeded", "failed", "blocked"] as const;

export type CorpusStatus = (typeof CORPUS_STATUSES)[number];

export const CC0_LICENSE_IDS = ["CC0"] as const;

export type AllowedLicenseId = (typeof CC0_LICENSE_IDS)[number];

export interface AssetLicense {
  id: string;
  name?: string | null;
  url?: string | null;
  redistributionAllowed: boolean | null;
  commercialUseAllowed: boolean | null;
}

export interface CorpusAssetIdentity {
  source: string;
  sourceAssetId: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface DiscoveredAssetInput extends CorpusAssetIdentity {
  name: string;
  author?: string | null;
  description?: string | null;
  sourceUrl: string;
  attribution?: string | null;
  attributionUrl?: string | null;
  license: AssetLicense;
  providerCategories?: readonly string[];
  sourceMetadata?: JsonObject;
  metadataFingerprint?: string;
}

export type ArtifactKind = "raw" | "derived" | "preview" | "metadata";

export interface ArtifactReference extends CorpusAssetIdentity {
  id: string;
  kind: ArtifactKind;
  path: string;
  filename: string;
  sourceName: string;
  format: string;
  sha256: string;
  byteSize: number;
  sourceUrl: string;
  attribution: string | null;
  attributionUrl: string | null;
  license: AssetLicense;
  downloadedAt: string;
  immutable: boolean;
  parentSha256: string | null;
  conversionVersion: string | null;
}

export interface VerifiedArtifactInput {
  kind: ArtifactKind;
  path: string;
  filename: string;
  sourceName: string;
  format: string;
  sha256: string;
  byteSize: number;
  sourceUrl: string;
  downloadedAt: string;
  immutable?: boolean;
  attribution?: string | null;
  attributionUrl?: string | null;
  parentSha256?: string | null;
  conversionVersion?: string | null;
}

export interface ArtifactWriteResult {
  artifact: ArtifactReference;
  /** True when the same content hash already had a canonical raw path. */
  deduplicated: boolean;
  canonicalPath: string;
}

export interface CorpusFailure {
  stage: CorpusStage;
  kind: string;
  message: string;
  attempt: number;
  failedAt: string;
  retryAt: string | null;
}

export type RecordFailureInput = Omit<CorpusFailure, "attempt" | "failedAt" | "retryAt"> & {
  failedAt?: string;
  retryAt?: string | null;
};

export interface InspectionRecord {
  inputSha256: string;
  inspectorVersion: string;
  fingerprintVersion: string;
  fingerprint: JsonObject;
  inspectedAt: string;
}

export interface ClassificationRecord {
  classificationVersion: string;
  /** Deterministic technical labels; use null for values that are unknown. */
  labels: JsonObject;
  classifiedAt: string;
}

export interface CorpusAsset extends DiscoveredAssetInput {
  licenseAllowed: boolean;
  stage: CorpusStage;
  status: CorpusStatus;
  failure: CorpusFailure | null;
  inspection: InspectionRecord | null;
  classification: ClassificationRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface CorpusAssetQuery {
  source?: string;
  sourceAssetId?: string;
  stage?: CorpusStage;
  status?: CorpusStatus;
  licenseAllowed?: boolean;
  classificationVersion?: string;
  classificationLabels?: Readonly<Record<string, string | number | boolean | null>>;
  limit?: number;
  offset?: number;
}

export interface RetryableQuery {
  now?: string;
  limit?: number;
}

export function isAllowedLicense(license: AssetLicense): license is AssetLicense & { id: AllowedLicenseId } {
  const normalizedId = license.id.trim().toUpperCase();
  return (
    (CC0_LICENSE_IDS as readonly string[]).includes(normalizedId) &&
    license.redistributionAllowed === true &&
    license.commercialUseAllowed === true
  );
}

export function corpusAssetKey(identity: CorpusAssetIdentity): string {
  return JSON.stringify([identity.source, identity.sourceAssetId]);
}
