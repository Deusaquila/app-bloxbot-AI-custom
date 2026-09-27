import { mkdtempSync, rmSync } from "node:fs";
import { relative, resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CorpusLicenseError, CorpusStore } from "./store";
import type { DiscoveredAssetInput, VerifiedArtifactInput } from "./domain";

const temporaryBase = resolve(tmpdir());
let temporaryDirectory = "";
let databasePath = "";
let store: CorpusStore;

function makeAsset(sourceAssetId: string, licenseId = "CC0"): DiscoveredAssetInput {
  return {
    source: "fixture-source",
    sourceAssetId,
    name: `Asset ${sourceAssetId}`,
    author: "Source creator",
    sourceUrl: `https://example.invalid/assets/${sourceAssetId}`,
    attribution: "Fixture display credit",
    attributionUrl: "https://example.invalid/authors/fixture",
    license: {
      id: licenseId,
      name: licenseId === "CC0" ? "CC0 1.0 Universal" : "CC BY 4.0",
      url: licenseId === "CC0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : "https://creativecommons.org/licenses/by/4.0/",
      redistributionAllowed: licenseId === "CC0",
      commercialUseAllowed: licenseId === "CC0",
    },
    providerCategories: ["football", "sports"],
    sourceMetadata: { resolution: "4k", optionalValue: null },
  };
}

function rawArtifact(path: string, sha256: string, sourceName: string): VerifiedArtifactInput {
  return {
    kind: "raw",
    path,
    filename: `${sourceName}.blend`,
    sourceName,
    format: "blend",
    sha256,
    byteSize: 1024,
    sourceUrl: `https://example.invalid/downloads/${sourceName}`,
    downloadedAt: "2026-09-27T12:30:00.000Z",
    immutable: true,
  };
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(temporaryBase, "bloxbot-corpus-test-"));
  databasePath = join(temporaryDirectory, "corpus.sqlite");
  store = new CorpusStore(databasePath);
});

afterEach(() => {
  store?.close();
  const target = resolve(temporaryDirectory);
  const relativeTarget = relative(temporaryBase, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to clean temp path outside the temp root: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
});

describe("CorpusStore", () => {
  it("persists the stable logical identity, license policy, inspection and classification across reopen", () => {
    const identity = { source: "fixture-source", sourceAssetId: "asset-1" };
    store.upsertDiscoveredAsset(makeAsset(identity.sourceAssetId));
    const hash = "a".repeat(64);
    store.recordVerifiedArtifact(identity, rawArtifact(join(temporaryDirectory, "raw", "asset-1.blend"), hash, "asset-1"));
    expect(() =>
      store.recordInspection(identity, {
        inputSha256: "f".repeat(64),
        inspectorVersion: "blender-inspector-2",
        fingerprintVersion: "fingerprint-1",
        fingerprint: { hasMesh: true },
        inspectedAt: "2026-09-27T12:31:00.000Z",
      }),
    ).toThrow(/match a verified raw artifact/);
    store.recordInspection(identity, {
      inputSha256: hash,
      inspectorVersion: "blender-inspector-2",
      fingerprintVersion: "fingerprint-1",
      fingerprint: { hasMesh: true, textureCount: null },
      inspectedAt: "2026-09-27T12:31:00.000Z",
    });
    store.recordClassification(identity, {
      classificationVersion: "classification-3",
      labels: { geometry: "mesh", textures: null, providerCategories: ["football", "sports"] },
      classifiedAt: "2026-09-27T12:32:00.000Z",
    });
    store.close();

    store = new CorpusStore(databasePath);
    const asset = store.getAsset(identity);
    expect(asset).not.toBeNull();
    expect(asset?.sourceAssetId).toBe("asset-1");
    expect(asset?.author).toBe("Source creator");
    expect(asset?.attribution).toBe("Fixture display credit");
    expect(asset?.licenseAllowed).toBe(true);
    expect(asset?.license.redistributionAllowed).toBe(true);
    expect(asset?.license.commercialUseAllowed).toBe(true);
    expect(asset?.stage).toBe("complete");
    expect(asset?.status).toBe("succeeded");
    expect(asset?.inspection?.inputSha256).toBe(hash);
    expect(asset?.inspection?.fingerprint.textureCount).toBeNull();
    expect(asset?.classification?.classificationVersion).toBe("classification-3");
    expect(asset?.classification?.labels.textures).toBeNull();
    expect(store.listAssets({ classificationVersion: "classification-3" })).toHaveLength(1);
    expect(store.listAssets({ classificationLabels: { geometry: "mesh", textures: null } })).toHaveLength(1);
    expect(store.listAssets({ classificationLabels: { meshCount: 0 } })).toHaveLength(0);
  });

  it("blocks unapproved licenses and rejects downstream writes", () => {
    const disallowed = makeAsset("cc-by-asset", "CC-BY-4.0");
    store.upsertDiscoveredAsset(disallowed);

    const saved = store.getAsset(disallowed);
    expect(saved?.licenseAllowed).toBe(false);
    expect(saved?.status).toBe("blocked");
    expect(() =>
      store.recordVerifiedArtifact(
        disallowed,
        rawArtifact(join(temporaryDirectory, "raw", "forbidden.blend"), "b".repeat(64), "forbidden"),
      ),
    ).toThrow(CorpusLicenseError);
  });

  it("adds nullable author when upgrading a schema v2 database", () => {
    const identity = { source: "fixture-source", sourceAssetId: "asset-v2" };
    store.upsertDiscoveredAsset(makeAsset(identity.sourceAssetId));
    store.close();

    const versionTwo = new DatabaseSync(databasePath);
    versionTwo.exec("ALTER TABLE assets DROP COLUMN author; PRAGMA user_version = 2;");
    versionTwo.close();

    store = new CorpusStore(databasePath);
    expect(store.getAsset(identity)?.author).toBeNull();
    store.upsertDiscoveredAsset({ ...makeAsset(identity.sourceAssetId), author: "Migrated creator" });
    expect(store.getAsset(identity)?.author).toBe("Migrated creator");
  });

  it("deduplicates raw content by hash without merging logical asset identities", () => {
    const first = { source: "fixture-source", sourceAssetId: "asset-a" };
    const second = { source: "fixture-source", sourceAssetId: "asset-b" };
    store.upsertDiscoveredAsset(makeAsset(first.sourceAssetId));
    store.upsertDiscoveredAsset(makeAsset(second.sourceAssetId));
    const hash = "c".repeat(64);
    const firstPath = join(temporaryDirectory, "raw", "asset-a.blend");
    const firstResult = store.recordVerifiedArtifact(first, rawArtifact(firstPath, hash, "asset-a"));
    const secondResult = store.recordVerifiedArtifact(
      second,
      rawArtifact(join(temporaryDirectory, "raw", "asset-b.blend"), hash, "asset-b"),
    );

    expect(firstResult.deduplicated).toBe(false);
    expect(secondResult.deduplicated).toBe(true);
    expect(secondResult.canonicalPath).toBe(firstPath);
    expect(store.listArtifacts(first)[0]?.sourceAssetId).toBe("asset-a");
    expect(store.listArtifacts(second)[0]?.sourceAssetId).toBe("asset-b");
    expect(store.listAssets()).toHaveLength(2);
  });

  it("validates raw artifact hash and immutability and tracks retry attempts", () => {
    const identity = { source: "fixture-source", sourceAssetId: "asset-retry" };
    store.upsertDiscoveredAsset(makeAsset(identity.sourceAssetId));
    const invalid = rawArtifact(join(temporaryDirectory, "raw", "bad.blend"), "not-a-hash", "bad");
    expect(() => store.recordVerifiedArtifact(identity, invalid)).toThrow(/SHA-256/);
    expect(() => store.recordVerifiedArtifact(identity, { ...invalid, sha256: "d".repeat(64), immutable: false })).toThrow(
      /immutable/,
    );

    store.recordFailure(identity, {
      stage: "download",
      kind: "network",
      message: "temporary fixture failure",
      retryAt: "2026-09-27T13:00:00.000Z",
    });
    const failed = store.recordFailure(identity, {
      stage: "download",
      kind: "network",
      message: "still unavailable",
      retryAt: "2026-09-27T14:00:00.000Z",
    });
    expect(failed.failure?.attempt).toBe(2);
    expect(failed.failure?.failedAt).toBeTruthy();
    expect(store.listRetryable({ now: "2026-09-27T13:30:00.000Z" })).toHaveLength(0);
    expect(store.listRetryable({ now: "2026-09-27T14:00:00.000Z" })).toHaveLength(1);
  });
});
