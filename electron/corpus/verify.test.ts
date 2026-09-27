import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ArtifactReference,
  CorpusAsset,
  DiscoveredAssetInput,
  VerifiedArtifactInput,
} from "./domain";
import { CorpusStore } from "./store";
import { verifyCorpus } from "./verify";

const TEST_DIRECTORY_PREFIX = "bloxbot-corpus-verify-test-";
const timestamp = "2026-09-27T12:30:00.000Z";
let temporaryDirectory = "";
let store: CorpusStore;

function makeAsset(sourceAssetId: string, licenseId = "CC0"): DiscoveredAssetInput {
  return {
    source: "fixture-source",
    sourceAssetId,
    name: `Asset ${sourceAssetId}`,
    sourceUrl: `https://example.invalid/assets/${sourceAssetId}`,
    attribution: "Fixture Author",
    attributionUrl: "https://example.invalid/authors/fixture",
    license: {
      id: licenseId,
      name: licenseId === "CC0" ? "CC0 1.0 Universal" : "Other license",
      url: licenseId === "CC0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : null,
      redistributionAllowed: licenseId === "CC0",
      commercialUseAllowed: licenseId === "CC0",
    },
  };
}

async function writeAssetFile(name: string, contents: string): Promise<string> {
  const rawDirectory = join(temporaryDirectory, "raw");
  await mkdir(rawDirectory, { recursive: true });
  const path = join(rawDirectory, name);
  await writeFile(path, contents, { flag: "wx" });
  return path;
}

function rawArtifactInput(
  asset: DiscoveredAssetInput,
  path: string,
  contents: string,
  overrides: Partial<VerifiedArtifactInput> = {},
): VerifiedArtifactInput {
  return {
    kind: "raw",
    path,
    filename: `${asset.sourceAssetId}.blend`,
    sourceName: asset.sourceAssetId,
    format: "blend",
    sha256: createHash("sha256").update(contents).digest("hex"),
    byteSize: Buffer.byteLength(contents),
    sourceUrl: asset.sourceUrl,
    downloadedAt: timestamp,
    immutable: true,
    ...overrides,
  };
}

function completeRecords(identity: { source: string; sourceAssetId: string }) {
  const rawArtifact = store.listArtifacts(identity).find((artifact) => artifact.kind === "raw");
  if (!rawArtifact) throw new Error("Complete test fixture requires a raw artifact");
  store.recordInspection(identity, {
    inspectorVersion: "sha256:inspector-script",
    fingerprintVersion: "asset-fingerprint-schema-v1",
    fingerprint: { format: "fbx" },
    inputSha256: rawArtifact.sha256,
    inspectedAt: timestamp,
  });
  store.recordClassification(identity, {
    classificationVersion: "corpus-rules-v1",
    labels: { meshCount: 1 },
    classifiedAt: timestamp,
  });
}

function issueCodes(result: Awaited<ReturnType<typeof verifyCorpus>>, sourceAssetId: string) {
  return result.assets.find((asset) => asset.sourceAssetId === sourceAssetId)?.issues.map((issue) => issue.code) ?? [];
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(await realpath(tmpdir()), TEST_DIRECTORY_PREFIX));
  store = new CorpusStore(":memory:");
});

afterEach(async () => {
  store?.close();
  const temporaryRoot = await realpath(tmpdir());
  const resolvedDirectory = await realpath(temporaryDirectory);
  const relativeDirectory = relative(temporaryRoot, resolvedDirectory);
  if (
    !relativeDirectory ||
    isAbsolute(relativeDirectory) ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    dirname(relativeDirectory) !== "." ||
    !basename(relativeDirectory).startsWith(TEST_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to recursively remove an unexpected test directory: ${resolvedDirectory}`);
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
});

describe("verifyCorpus", () => {
  it("accepts a distinct HTTPS CDN URL and verifies raw bytes and asset completeness", async () => {
    const input = makeAsset("valid");
    const identity = { source: input.source, sourceAssetId: input.sourceAssetId };
    store.upsertDiscoveredAsset(input);
    const contents = "verified raw asset";
    const path = await writeAssetFile("valid.blend", contents);
    const artifactUrl = "https://cdn.example.invalid/downloads/valid.blend";
    store.recordVerifiedArtifact(
      identity,
      rawArtifactInput(input, path, contents, { sourceUrl: artifactUrl }),
    );
    expect(store.listArtifacts(identity)[0]?.sourceUrl).toBe(artifactUrl);
    expect(artifactUrl).not.toBe(input.sourceUrl);
    completeRecords(identity);

    const result = await verifyCorpus(store);

    expect(result.complete).toBe(true);
    expect(result.counts).toMatchObject({
      assetsChecked: 1,
      completeAssets: 1,
      incompleteAssets: 0,
      artifactsChecked: 1,
      verifiedArtifacts: 1,
      bytesChecked: Buffer.byteLength(contents),
      issues: 0,
    });
    expect(result.issues).toEqual([]);
    expect(result.assets[0]).toMatchObject({ complete: true, rawArtifactCount: 1 });
  });

  it("reports corrupt and missing files while continuing to verify later assets", async () => {
    const corruptInput = makeAsset("a-corrupt");
    const corruptIdentity = { source: corruptInput.source, sourceAssetId: corruptInput.sourceAssetId };
    store.upsertDiscoveredAsset(corruptInput);
    const originalContents = "original";
    const corruptPath = await writeAssetFile("corrupt.blend", originalContents);
    store.recordVerifiedArtifact(
      corruptIdentity,
      rawArtifactInput(corruptInput, corruptPath, originalContents, {
        sourceUrl: "https://cdn.example.invalid/downloads/a-corrupt.blend",
      }),
    );
    completeRecords(corruptIdentity);
    await writeFile(corruptPath, "tampered!");

    const missingInput = makeAsset("b-missing");
    const missingIdentity = { source: missingInput.source, sourceAssetId: missingInput.sourceAssetId };
    store.upsertDiscoveredAsset(missingInput);
    const missingPath = join(temporaryDirectory, "raw", "missing.blend");
    store.recordVerifiedArtifact(missingIdentity, rawArtifactInput(missingInput, missingPath, "not present"));

    const validInput = makeAsset("c-valid");
    const validIdentity = { source: validInput.source, sourceAssetId: validInput.sourceAssetId };
    store.upsertDiscoveredAsset(validInput);
    const validContents = "later asset remains verifiable";
    const validPath = await writeAssetFile("later.blend", validContents);
    store.recordVerifiedArtifact(validIdentity, rawArtifactInput(validInput, validPath, validContents));
    completeRecords(validIdentity);

    const result = await verifyCorpus(store);

    expect(result.complete).toBe(false);
    expect(result.counts).toMatchObject({ assetsChecked: 3, completeAssets: 1, incompleteAssets: 2 });
    expect(issueCodes(result, "a-corrupt")).toEqual(
      expect.arrayContaining([
        "ARTIFACT_BYTE_SIZE_MISMATCH",
        "ARTIFACT_CONTENT_HASH_MISMATCH",
        "ASSET_INSPECTION_STALE",
      ]),
    );
    expect(issueCodes(result, "a-corrupt")).not.toContain("ARTIFACT_SOURCE_URL_INVALID");
    expect(issueCodes(result, "a-corrupt")).not.toContain("ARTIFACT_ATTRIBUTION_PROVENANCE_MISMATCH");
    expect(issueCodes(result, "b-missing")).toContain("ARTIFACT_FILE_MISSING");
    expect(issueCodes(result, "c-valid")).toEqual([]);
    expect(result.counts.bytesChecked).toBe(Buffer.byteLength("tampered!") + Buffer.byteLength(validContents));
  });

  it("reports incomplete and disallowed assets instead of treating absent records as verified", async () => {
    const blocked = makeAsset("blocked", "CC-BY-4.0");
    store.upsertDiscoveredAsset(blocked);

    const result = await verifyCorpus(store);

    expect(result.complete).toBe(false);
    expect(issueCodes(result, "blocked")).toEqual(
      expect.arrayContaining([
        "ASSET_LICENSE_NOT_ALLOWED",
        "ASSET_INSPECTION_MISSING",
        "ASSET_CLASSIFICATION_MISSING",
        "ASSET_STATE_INCOMPLETE",
        "ASSET_RAW_ARTIFACT_MISSING",
      ]),
    );
  });

  it("checks immutable flags and source/license/hash lineage in returned artifact records", async () => {
    const assetInput = makeAsset("tampered-metadata");
    const asset: CorpusAsset = {
      ...assetInput,
      licenseAllowed: true,
      stage: "complete",
      status: "succeeded",
      failure: null,
      inspection: {
        inspectorVersion: "inspector-v1",
        fingerprintVersion: "fingerprint-v1",
        fingerprint: {},
        inputSha256: "a".repeat(64),
        inspectedAt: timestamp,
      },
      classification: { classificationVersion: "", labels: {}, classifiedAt: timestamp },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const artifact: ArtifactReference = {
      id: "bad-raw",
      source: "different-source",
      sourceAssetId: "different-id",
      kind: "raw",
      path: join(temporaryDirectory, "not-present.blend"),
      filename: "",
      sourceName: "",
      format: "",
      sha256: "invalid",
      byteSize: 0,
      sourceUrl: "http://example.invalid/wrong-source",
      attribution: null,
      attributionUrl: null,
      license: { ...asset.license, id: "CC-BY-4.0" },
      downloadedAt: timestamp,
      immutable: false,
      parentSha256: "a".repeat(64),
      conversionVersion: "unexpected",
    };
    const reader = {
      listAssets: () => [asset],
      listArtifacts: () => [artifact],
    };

    const result = await verifyCorpus(reader);

    expect(issueCodes(result, "tampered-metadata")).toEqual(
      expect.arrayContaining([
        "ARTIFACT_IDENTITY_MISMATCH",
        "ARTIFACT_SOURCE_URL_INVALID",
        "ARTIFACT_ATTRIBUTION_PROVENANCE_MISMATCH",
        "ARTIFACT_LICENSE_PROVENANCE_MISMATCH",
        "ARTIFACT_METADATA_MISSING",
        "ARTIFACT_HASH_INVALID",
        "ARTIFACT_BYTE_SIZE_INVALID",
        "RAW_ARTIFACT_NOT_IMMUTABLE",
        "RAW_ARTIFACT_HAS_PARENT",
        "RAW_ARTIFACT_HAS_CONVERSION_VERSION",
        "ARTIFACT_PARENT_HASH_UNKNOWN",
        "ARTIFACT_FILE_MISSING",
        "ASSET_INSPECTION_STALE",
        "ASSET_CLASSIFICATION_VERSION_MISSING",
      ]),
    );
    expect(result.assets[0]?.complete).toBe(false);
  });
});
