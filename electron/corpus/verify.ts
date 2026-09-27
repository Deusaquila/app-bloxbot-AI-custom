import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type { ArtifactReference, CorpusAsset, CorpusAssetIdentity, CorpusAssetQuery } from "./domain";
import { isAllowedLicense } from "./domain";
import type { CorpusStore } from "./store";

const PAGE_SIZE = 1000;
const SHA256_PATTERN = /^[a-f\d]{64}$/i;

export type CorpusVerificationIssueCode =
  | "ASSET_LICENSE_NOT_ALLOWED"
  | "ASSET_ARTIFACT_LIST_FAILED"
  | "ASSET_RAW_ARTIFACT_MISSING"
  | "ASSET_INSPECTION_MISSING"
  | "ASSET_INSPECTION_VERSION_MISSING"
  | "ASSET_INSPECTION_STALE"
  | "ASSET_CLASSIFICATION_MISSING"
  | "ASSET_CLASSIFICATION_VERSION_MISSING"
  | "ASSET_STATE_INCOMPLETE"
  | "ARTIFACT_IDENTITY_MISMATCH"
  | "ARTIFACT_SOURCE_URL_INVALID"
  | "ARTIFACT_ATTRIBUTION_PROVENANCE_MISMATCH"
  | "ARTIFACT_LICENSE_PROVENANCE_MISMATCH"
  | "ARTIFACT_METADATA_MISSING"
  | "ARTIFACT_HASH_INVALID"
  | "ARTIFACT_BYTE_SIZE_INVALID"
  | "RAW_ARTIFACT_NOT_IMMUTABLE"
  | "RAW_ARTIFACT_HAS_PARENT"
  | "RAW_ARTIFACT_HAS_CONVERSION_VERSION"
  | "DERIVED_ARTIFACT_PARENT_MISSING"
  | "DERIVED_ARTIFACT_CONVERSION_VERSION_MISSING"
  | "ARTIFACT_PARENT_HASH_UNKNOWN"
  | "ARTIFACT_FILE_MISSING"
  | "ARTIFACT_FILE_READ_FAILED"
  | "ARTIFACT_BYTE_SIZE_MISMATCH"
  | "ARTIFACT_CONTENT_HASH_MISMATCH";

export interface CorpusVerificationIssue {
  code: CorpusVerificationIssueCode;
  severity: "error";
  message: string;
  source: string;
  sourceAssetId: string;
  artifactId?: string;
  path?: string;
}

export interface CorpusAssetVerification {
  source: string;
  sourceAssetId: string;
  complete: boolean;
  artifactCount: number;
  rawArtifactCount: number;
  verifiedArtifactCount: number;
  bytesChecked: number;
  issues: CorpusVerificationIssue[];
}

export interface CorpusVerificationResult {
  verifiedAt: string;
  complete: boolean;
  counts: {
    assetsChecked: number;
    completeAssets: number;
    incompleteAssets: number;
    artifactsChecked: number;
    verifiedArtifacts: number;
    bytesChecked: number;
    issues: number;
  };
  assets: CorpusAssetVerification[];
  issues: CorpusVerificationIssue[];
}

type CorpusStoreReader = Pick<CorpusStore, "listAssets" | "listArtifacts">;

interface HashedFile {
  sha256: string;
  byteSize: number;
}

async function hashFile(path: string): Promise<HashedFile> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

function errorCode(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function licenseId(value: string): string {
  return value.trim().toUpperCase();
}

function isValidHttpsUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function sameLicense(left: ArtifactReference["license"], right: CorpusAsset["license"]): boolean {
  return (
    licenseId(left.id) === licenseId(right.id) &&
    (left.name ?? null) === (right.name ?? null) &&
    (left.url ?? null) === (right.url ?? null) &&
    left.redistributionAllowed === right.redistributionAllowed &&
    left.commercialUseAllowed === right.commercialUseAllowed
  );
}

function listAllAssets(store: CorpusStoreReader, query: CorpusAssetQuery): CorpusAsset[] {
  if (query.limit !== undefined) return store.listAssets(query);

  const assets: CorpusAsset[] = [];
  let offset = query.offset ?? 0;
  while (true) {
    const page = store.listAssets({ ...query, limit: PAGE_SIZE, offset });
    assets.push(...page);
    if (page.length < PAGE_SIZE) return assets;
    offset += PAGE_SIZE;
  }
}

function addIssue(
  issues: CorpusVerificationIssue[],
  identity: CorpusAssetIdentity,
  code: CorpusVerificationIssueCode,
  message: string,
  artifact?: ArtifactReference,
): void {
  issues.push({
    code,
    severity: "error",
    message,
    source: identity.source,
    sourceAssetId: identity.sourceAssetId,
    ...(artifact ? { artifactId: artifact.id, path: artifact.path } : {}),
  });
}

function inspectArtifactMetadata(
  asset: CorpusAsset,
  artifact: ArtifactReference,
  knownHashes: ReadonlySet<string>,
): CorpusVerificationIssue[] {
  const issues: CorpusVerificationIssue[] = [];
  const identity = { source: asset.source, sourceAssetId: asset.sourceAssetId };
  if (artifact.source !== asset.source || artifact.sourceAssetId !== asset.sourceAssetId) {
    addIssue(issues, identity, "ARTIFACT_IDENTITY_MISMATCH", "Artifact identity does not match its asset.", artifact);
  }
  if (!isValidHttpsUrl(artifact.sourceUrl)) {
    addIssue(
      issues,
      identity,
      "ARTIFACT_SOURCE_URL_INVALID",
      "Artifact source URL must be a valid nonempty HTTPS URL.",
      artifact,
    );
  }
  if (
    artifact.attribution !== (asset.attribution ?? null) ||
    artifact.attributionUrl !== (asset.attributionUrl ?? null)
  ) {
    addIssue(
      issues,
      identity,
      "ARTIFACT_ATTRIBUTION_PROVENANCE_MISMATCH",
      "Artifact attribution does not match the discovered asset metadata.",
      artifact,
    );
  }
  if (!sameLicense(artifact.license, asset.license)) {
    addIssue(
      issues,
      identity,
      "ARTIFACT_LICENSE_PROVENANCE_MISMATCH",
      "Artifact license metadata does not match the discovered asset license.",
      artifact,
    );
  }
  if (
    !artifact.filename.trim() ||
    !artifact.sourceName.trim() ||
    !artifact.format.trim() ||
    !artifact.downloadedAt.trim()
  ) {
    addIssue(issues, identity, "ARTIFACT_METADATA_MISSING", "Artifact provenance metadata is incomplete.", artifact);
  }
  if (!SHA256_PATTERN.test(artifact.sha256)) {
    addIssue(issues, identity, "ARTIFACT_HASH_INVALID", "Artifact SHA-256 is missing or malformed.", artifact);
  }
  if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0) {
    addIssue(issues, identity, "ARTIFACT_BYTE_SIZE_INVALID", "Artifact byte size is not a positive safe integer.", artifact);
  }

  if (artifact.kind === "raw") {
    if (!artifact.immutable) {
      addIssue(issues, identity, "RAW_ARTIFACT_NOT_IMMUTABLE", "Raw artifacts must be marked immutable.", artifact);
    }
    if (artifact.parentSha256 !== null) {
      addIssue(issues, identity, "RAW_ARTIFACT_HAS_PARENT", "Raw artifacts cannot declare a parent hash.", artifact);
    }
    if (artifact.conversionVersion !== null) {
      addIssue(
        issues,
        identity,
        "RAW_ARTIFACT_HAS_CONVERSION_VERSION",
        "Raw artifacts cannot declare a conversion version.",
        artifact,
      );
    }
  } else if (artifact.kind === "derived") {
    if (!artifact.parentSha256) {
      addIssue(
        issues,
        identity,
        "DERIVED_ARTIFACT_PARENT_MISSING",
        "Derived artifacts must identify their parent content hash.",
        artifact,
      );
    }
    if (!artifact.conversionVersion?.trim()) {
      addIssue(
        issues,
        identity,
        "DERIVED_ARTIFACT_CONVERSION_VERSION_MISSING",
        "Derived artifacts must identify the conversion version.",
        artifact,
      );
    }
  }

  if (artifact.parentSha256 && !knownHashes.has(artifact.parentSha256.toLowerCase())) {
    addIssue(
      issues,
      identity,
      "ARTIFACT_PARENT_HASH_UNKNOWN",
      "Artifact parent hash does not reference another artifact for this asset.",
      artifact,
    );
  }
  return issues;
}

function assetIssues(asset: CorpusAsset): CorpusVerificationIssue[] {
  const issues: CorpusVerificationIssue[] = [];
  const identity = { source: asset.source, sourceAssetId: asset.sourceAssetId };
  if (!asset.licenseAllowed || !isAllowedLicense(asset.license)) {
    addIssue(issues, identity, "ASSET_LICENSE_NOT_ALLOWED", "Asset license is not allowed by the corpus policy.");
  }
  if (!asset.inspection) {
    addIssue(issues, identity, "ASSET_INSPECTION_MISSING", "Asset has no persisted inspection record.");
  } else if (!asset.inspection.inspectorVersion.trim() || !asset.inspection.fingerprintVersion.trim()) {
    addIssue(
      issues,
      identity,
      "ASSET_INSPECTION_VERSION_MISSING",
      "Inspection record must identify its inspector and fingerprint versions.",
    );
  }
  if (!asset.classification) {
    addIssue(issues, identity, "ASSET_CLASSIFICATION_MISSING", "Asset has no persisted classification record.");
  } else if (!asset.classification.classificationVersion.trim()) {
    addIssue(
      issues,
      identity,
      "ASSET_CLASSIFICATION_VERSION_MISSING",
      "Classification record has no classification version.",
    );
  }
  if (asset.stage !== "complete" || asset.status !== "succeeded") {
    addIssue(
      issues,
      identity,
      "ASSET_STATE_INCOMPLETE",
      `Asset state is ${asset.stage}/${asset.status}; expected complete/succeeded.`,
    );
  }
  return issues;
}

/** Verify corpus records and files using only the CorpusStore's public read methods. */
export async function verifyCorpus(
  store: CorpusStoreReader,
  query: CorpusAssetQuery = {},
): Promise<CorpusVerificationResult> {
  const records = listAllAssets(store, query);
  const assets: CorpusAssetVerification[] = [];
  let artifactsChecked = 0;
  let verifiedArtifacts = 0;
  let bytesChecked = 0;

  for (const asset of records) {
    const identity = { source: asset.source, sourceAssetId: asset.sourceAssetId };
    const issues = assetIssues(asset);
    let artifacts: ArtifactReference[] = [];
    try {
      artifacts = store.listArtifacts(identity);
    } catch (cause) {
      addIssue(
        issues,
        identity,
        "ASSET_ARTIFACT_LIST_FAILED",
        `Could not list asset artifacts: ${errorMessage(cause)}`,
      );
    }

    const rawArtifacts = artifacts.filter((artifact) => artifact.kind === "raw");
    if (rawArtifacts.length === 0) {
      addIssue(issues, identity, "ASSET_RAW_ARTIFACT_MISSING", "Asset has no recorded raw artifact.");
    }
    const knownHashes = new Set(
      artifacts.filter((artifact) => SHA256_PATTERN.test(artifact.sha256)).map((artifact) => artifact.sha256.toLowerCase()),
    );
    const verifiedRawHashes = new Set<string>();
    let verifiedArtifactCount = 0;
    let assetBytesChecked = 0;

    for (const artifact of artifacts) {
      artifactsChecked++;
      const artifactFindings = inspectArtifactMetadata(asset, artifact, knownHashes);
      if (!artifact.path.trim()) {
        addIssue(artifactFindings, identity, "ARTIFACT_FILE_MISSING", "Artifact path is empty.", artifact);
      } else {
        try {
          const actual = await hashFile(artifact.path);
          assetBytesChecked += actual.byteSize;
          if (actual.byteSize !== artifact.byteSize) {
            addIssue(
              artifactFindings,
              identity,
              "ARTIFACT_BYTE_SIZE_MISMATCH",
              `Stored byte size ${artifact.byteSize} does not match file size ${actual.byteSize}.`,
              artifact,
            );
          }
          if (SHA256_PATTERN.test(artifact.sha256) && actual.sha256 !== artifact.sha256.toLowerCase()) {
            addIssue(
              artifactFindings,
              identity,
              "ARTIFACT_CONTENT_HASH_MISMATCH",
              "Stored SHA-256 does not match the file contents.",
              artifact,
            );
          }
        } catch (cause) {
          const missing = errorCode(cause) === "ENOENT" || errorCode(cause) === "ENOTDIR";
          addIssue(
            artifactFindings,
            identity,
            missing ? "ARTIFACT_FILE_MISSING" : "ARTIFACT_FILE_READ_FAILED",
            missing ? "Artifact file does not exist." : `Could not read artifact file: ${errorMessage(cause)}`,
            artifact,
          );
        }
      }

      if (artifactFindings.length === 0) {
        verifiedArtifactCount++;
        if (artifact.kind === "raw") verifiedRawHashes.add(artifact.sha256.toLowerCase());
      }
      issues.push(...artifactFindings);
    }

    if (
      asset.inspection &&
      (!SHA256_PATTERN.test(asset.inspection.inputSha256) ||
        !verifiedRawHashes.has(asset.inspection.inputSha256.toLowerCase()))
    ) {
      addIssue(
        issues,
        identity,
        "ASSET_INSPECTION_STALE",
        "Inspection input hash does not match a verified raw artifact for this asset.",
      );
    }

    const complete =
      rawArtifacts.length > 0 &&
      asset.inspection !== null &&
      asset.classification !== null &&
      asset.stage === "complete" &&
      asset.status === "succeeded" &&
      issues.length === 0;
    bytesChecked += assetBytesChecked;
    verifiedArtifacts += verifiedArtifactCount;
    assets.push({
      source: asset.source,
      sourceAssetId: asset.sourceAssetId,
      complete,
      artifactCount: artifacts.length,
      rawArtifactCount: rawArtifacts.length,
      verifiedArtifactCount,
      bytesChecked: assetBytesChecked,
      issues,
    });
  }

  const issues = assets.flatMap((asset) => asset.issues);
  const completeAssets = assets.filter((asset) => asset.complete).length;
  const incompleteAssets = assets.length - completeAssets;
  return {
    verifiedAt: new Date().toISOString(),
    complete: assets.length > 0 && incompleteAssets === 0,
    counts: {
      assetsChecked: assets.length,
      completeAssets,
      incompleteAssets,
      artifactsChecked,
      verifiedArtifacts,
      bytesChecked,
      issues: issues.length,
    },
    assets,
    issues,
  };
}
