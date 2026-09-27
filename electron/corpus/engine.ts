import { createHash } from "node:crypto";
import { join } from "node:path";

import type { AssetFingerprint } from "../../src/types/asset";
import { CLASSIFICATION_VERSION, classifyFingerprint } from "./classification";
import type { CorpusAsset, CorpusAssetIdentity, CorpusAssetQuery, CorpusStage, JsonObject } from "./domain";
import { inspectCorpusAsset } from "./inspection";
import { selectDiverseAssets } from "./selection";
import type { CorpusSource } from "./source";
import { download } from "./download";
import { CorpusStore } from "./store";

const FINGERPRINT_VERSION = "production-asset-fingerprint-v1";

export interface CorpusEngineOptions {
  store: CorpusStore;
  source: CorpusSource;
  evaluationRoot: string;
  blenderExecutable: string;
  blenderScript: string;
  concurrency?: number;
}

export interface IngestResult {
  selected: number;
  succeeded: number;
  failed: number;
  blocked: number;
  assets: CorpusAsset[];
}

export interface CorpusStatusSummary {
  total: number;
  complete: number;
  failed: number;
  blocked: number;
  pending: number;
  withVerifiedRaw: number;
  withInspection: number;
}

function assetIdentity(asset: CorpusAsset): CorpusAssetIdentity {
  return { source: asset.source, sourceAssetId: asset.sourceAssetId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function stableDirectory(source: string, sourceAssetId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(source)) throw new Error("Invalid source name");
  return createHash("sha256").update(JSON.stringify([source, sourceAssetId])).digest("hex").slice(0, 24);
}

async function runBounded<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item);
      }
    }),
  );
}

export class CorpusEngine {
  private readonly concurrency: number;
  private readonly inspectorVersion: string;

  constructor(private readonly options: CorpusEngineOptions) {
    this.concurrency = options.concurrency ?? 3;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw new Error("Corpus concurrency must be an integer from 1 through 8");
    }
    this.inspectorVersion = `sha256:${createHash("sha256").update(options.blenderScript).digest("hex")}`;
  }

  async discover(limit = 20): Promise<CorpusAsset[]> {
    const discovered = await this.options.source.discover();
    const selected = selectDiverseAssets(discovered, limit);
    return selected.map((item) => this.options.store.upsertDiscoveredAsset(item));
  }

  async ingest(limit = 20): Promise<IngestResult> {
    return this.ingestAssets(await this.discover(limit));
  }

  async retry(limit = 20): Promise<IngestResult> {
    return this.ingestAssets(this.options.store.listRetryable({ limit }));
  }

  private async ingestAssets(selected: CorpusAsset[]): Promise<IngestResult> {
    const result: IngestResult = { selected: selected.length, succeeded: 0, failed: 0, blocked: 0, assets: [] };
    await runBounded(selected, this.concurrency, async (asset) => {
      if (!asset.licenseAllowed) {
        result.blocked += 1;
        result.assets.push(asset);
        return;
      }
      const updated = await this.ingestOne(asset);
      result.assets.push(updated);
      if (updated.status === "succeeded") result.succeeded += 1;
      else if (updated.status === "failed") result.failed += 1;
    });
    result.assets.sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId));
    return result;
  }

  private async ingestOne(asset: CorpusAsset): Promise<CorpusAsset> {
    const identity = assetIdentity(asset);
    let stage: CorpusStage = "metadata";
    try {
      const options = await this.options.source.getDownloadOptions(asset.sourceAssetId);
      const files = [options.primary, ...options.dependencies];
      const destination = join(
        this.options.evaluationRoot,
        "corpus",
        "raw",
        asset.source,
        stableDirectory(asset.source, asset.sourceAssetId),
      );
      let primaryPath = "";
      let primaryHash = "";
      for (const option of files) {
        stage = "download";
        const fetched = await download(option, destination);
        stage = "hash";
        const known = this.options.store.listArtifacts(identity).some(
          (item) => item.kind === "raw" && item.sha256 === fetched.sha256 && item.filename === option.filename,
        );
        if (!known) {
          this.options.store.recordVerifiedArtifact(identity, {
            kind: "raw",
            path: fetched.path,
            filename: option.filename,
            sourceName: option.filename,
            format: option.format,
            sha256: fetched.sha256,
            byteSize: fetched.byteSize,
            sourceUrl: option.sourceUrl,
            downloadedAt: fetched.downloadedAt,
            immutable: true,
          });
        }
        if (option.role === "primary") {
          primaryPath = fetched.path;
          primaryHash = fetched.sha256;
        }
      }
      if (!primaryPath || !primaryHash) throw new Error("Source did not provide a verified primary file");
      return await this.inspectAndClassify(identity, primaryPath, primaryHash, (next) => { stage = next; });
    } catch (error) {
      return this.options.store.recordFailure(identity, {
        stage,
        kind: errorKind(error),
        message: errorMessage(error),
      });
    }
  }

  async inspectPending(limit = 100): Promise<IngestResult> {
    const selected = this.options.store.listAssets({
      source: this.options.source.sourceName,
      licenseAllowed: true,
      limit: 10000,
    }).filter((asset) => {
      const primary = this.options.store.listArtifacts(assetIdentity(asset))
        .filter((item) => item.kind === "raw" && item.format === "fbx").at(-1);
      return primary && (
        asset.inspection?.inputSha256 !== primary.sha256 ||
        asset.inspection?.inspectorVersion !== this.inspectorVersion ||
        asset.classification?.classificationVersion !== CLASSIFICATION_VERSION
      );
    }).slice(0, limit);
    const result: IngestResult = { selected: selected.length, succeeded: 0, failed: 0, blocked: 0, assets: [] };
    await runBounded(selected, this.concurrency, async (asset) => {
      const identity = assetIdentity(asset);
      const primary = this.options.store.listArtifacts(identity).filter((item) => item.kind === "raw" && item.format === "fbx").at(-1);
      if (!primary) return;
      if (
        asset.inspection?.inputSha256 === primary.sha256 &&
        asset.inspection?.inspectorVersion === this.inspectorVersion &&
        asset.classification?.classificationVersion === CLASSIFICATION_VERSION
      ) return;
      let stage: CorpusStage = "inspection";
      try {
        const updated = await this.inspectAndClassify(identity, primary.path, primary.sha256, (next) => { stage = next; });
        result.assets.push(updated);
        if (updated.status === "succeeded") result.succeeded += 1;
        else if (updated.status === "failed") result.failed += 1;
      } catch (error) {
        result.failed += 1;
        result.assets.push(this.options.store.recordFailure(identity, {
          stage,
          kind: errorKind(error),
          message: errorMessage(error),
        }));
      }
    });
    return result;
  }

  private async inspectAndClassify(
    identity: CorpusAssetIdentity,
    primaryPath: string,
    primaryHash: string,
    onStage: (stage: CorpusStage) => void = () => undefined,
  ): Promise<CorpusAsset> {
    let current = this.options.store.getAsset(identity);
    if (!current) throw new Error("Corpus asset vanished during inspection");
    if (current.inspection?.inputSha256 !== primaryHash || current.inspection?.inspectorVersion !== this.inspectorVersion) {
      onStage("inspection");
      this.options.store.setStage(identity, "inspection", "in_progress");
      const inspected = await inspectCorpusAsset({
        assetId: `${identity.source}:${identity.sourceAssetId}`,
        sourcePath: primaryPath,
        blenderExecutable: this.options.blenderExecutable,
        blenderScript: this.options.blenderScript,
      });
      if (inspected.status !== "INSPECTED") throw new Error(`Unsupported inspection format: ${inspected.extension}`);
      current = this.options.store.recordInspection(identity, {
        inspectorVersion: inspected.inspectorVersion,
        fingerprintVersion: FINGERPRINT_VERSION,
        inputSha256: primaryHash,
        fingerprint: JSON.parse(JSON.stringify(inspected.fingerprint)) as JsonObject,
        inspectedAt: new Date().toISOString(),
      });
    }
    if (current.classification?.classificationVersion !== CLASSIFICATION_VERSION) {
      onStage("classification");
      this.options.store.setStage(identity, "classification", "in_progress");
      const fingerprint = current.inspection?.fingerprint as unknown as AssetFingerprint | undefined;
      if (!fingerprint) throw new Error("Classification requires an inspection fingerprint");
      const classification = classifyFingerprint(fingerprint);
      current = this.options.store.recordClassification(identity, {
        classificationVersion: classification.version,
        labels: JSON.parse(JSON.stringify(classification.labels)) as JsonObject,
        classifiedAt: new Date().toISOString(),
      });
    }
    if (current.stage !== "complete" || current.status !== "succeeded") {
      current = this.options.store.setStage(identity, "complete", "succeeded");
    }
    return current;
  }

  query(query: CorpusAssetQuery = {}): CorpusAsset[] {
    return this.options.store.listAssets(query);
  }

  status(): CorpusStatusSummary {
    const assets = this.options.store.listAssets({ limit: 10000 });
    return {
      total: assets.length,
      complete: assets.filter((asset) => asset.status === "succeeded").length,
      failed: assets.filter((asset) => asset.status === "failed").length,
      blocked: assets.filter((asset) => asset.status === "blocked").length,
      pending: assets.filter((asset) => asset.status === "pending" || asset.status === "in_progress").length,
      withVerifiedRaw: assets.filter((asset) => this.options.store.listArtifacts(assetIdentity(asset)).some((item) => item.kind === "raw")).length,
      withInspection: assets.filter((asset) => asset.inspection !== null).length,
    };
  }
}
