import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ArtifactReference,
  type ArtifactWriteResult,
  type ClassificationRecord,
  type CorpusAsset,
  type CorpusAssetIdentity,
  type CorpusAssetQuery,
  type CorpusFailure,
  type CorpusStage,
  type CorpusStatus,
  type DiscoveredAssetInput,
  type InspectionRecord,
  type JsonObject,
  type RecordFailureInput,
  type RetryableQuery,
  type VerifiedArtifactInput,
  isAllowedLicense,
} from "./domain";

type SqlRow = Record<string, unknown>;

export class CorpusStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorpusStoreError";
  }
}

export class CorpusLicenseError extends CorpusStoreError {
  constructor(identity: CorpusAssetIdentity, licenseId: string) {
    super(`Asset ${identity.source}/${identity.sourceAssetId} has disallowed license '${licenseId}'`);
    this.name = "CorpusLicenseError";
  }
}

const SCHEMA_VERSION = 3;

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CorpusStoreError(`${field} must be a non-empty string`);
  }
}

function validateIdentity(identity: CorpusAssetIdentity): void {
  assertNonEmpty(identity.source, "source");
  assertNonEmpty(identity.sourceAssetId, "sourceAssetId");
}

function validateTimestamp(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (Number.isNaN(Date.parse(value))) throw new CorpusStoreError(`${field} must be a valid timestamp`);
}

function serializeJson(value: unknown, field: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return serialized;
  } catch (cause) {
    throw new CorpusStoreError(`${field} must be JSON serializable`, { cause });
  }
}

function parseJson<T>(value: unknown, fallback: T, field: string): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new CorpusStoreError(`Stored ${field} JSON is invalid`, { cause });
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === 1 || value === true;
}

function row<T extends SqlRow = SqlRow>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null;
}

function ensureJsonObject(value: unknown, field: string): JsonObject {
  const encoded = serializeJson(value, field);
  const decoded: unknown = JSON.parse(encoded);
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new CorpusStoreError(`${field} must be a JSON object`);
  }
  return decoded as JsonObject;
}

export class CorpusStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  upsertDiscoveredAsset(input: DiscoveredAssetInput): CorpusAsset {
    validateIdentity(input);
    assertNonEmpty(input.name, "name");
    assertNonEmpty(input.sourceUrl, "sourceUrl");
    assertNonEmpty(input.license.id, "license.id");
    const now = new Date().toISOString();
    const providerCategories = serializeJson(input.providerCategories ?? [], "providerCategories");
    const sourceMetadata = serializeJson(input.sourceMetadata ?? {}, "sourceMetadata");
    const allowed = isAllowedLicense(input.license);

    this.transaction(() => {
      const existing = row(
        this.database
          .prepare("SELECT stage, status FROM assets WHERE source = ? AND source_asset_id = ?")
          .get(input.source, input.sourceAssetId),
      );
      const wasBlocked = existing?.status === "blocked";
      const stage: CorpusStage = !allowed ? "discovery" : wasBlocked ? "discovery" : "discovery";
      const status: CorpusStatus = !allowed ? "blocked" : wasBlocked ? "pending" : "pending";

      this.database
        .prepare(
          `INSERT INTO assets (
            source, source_asset_id, name, author, description, source_url, attribution,
            attribution_url, license_id, license_name, license_url, provider_categories_json,
            license_redistribution_allowed, license_commercial_allowed, source_metadata_json,
            metadata_fingerprint, license_allowed, stage, status,
            failure_stage, failure_kind, failure_message, failure_attempt, failed_at, retry_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)
          ON CONFLICT(source, source_asset_id) DO UPDATE SET
            name = excluded.name,
            author = excluded.author,
            description = excluded.description,
            source_url = excluded.source_url,
            attribution = excluded.attribution,
            attribution_url = excluded.attribution_url,
            license_id = excluded.license_id,
            license_name = excluded.license_name,
            license_url = excluded.license_url,
            license_redistribution_allowed = excluded.license_redistribution_allowed,
            license_commercial_allowed = excluded.license_commercial_allowed,
            provider_categories_json = excluded.provider_categories_json,
            source_metadata_json = excluded.source_metadata_json,
            metadata_fingerprint = excluded.metadata_fingerprint,
            license_allowed = excluded.license_allowed,
            stage = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN excluded.stage ELSE assets.stage END,
            status = CASE WHEN excluded.license_allowed = 0 THEN 'blocked' WHEN assets.status = 'blocked' THEN 'pending' ELSE assets.status END,
            failure_stage = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN NULL ELSE assets.failure_stage END,
            failure_kind = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN NULL ELSE assets.failure_kind END,
            failure_message = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN NULL ELSE assets.failure_message END,
            failure_attempt = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN 0 ELSE assets.failure_attempt END,
            failed_at = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN NULL ELSE assets.failed_at END,
            retry_at = CASE WHEN excluded.license_allowed = 0 OR assets.status = 'blocked' THEN NULL ELSE assets.retry_at END,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.source,
          input.sourceAssetId,
          input.name,
          input.author ?? null,
          input.description ?? null,
          input.sourceUrl,
          input.attribution ?? null,
          input.attributionUrl ?? null,
          input.license.id.trim(),
          input.license.name ?? null,
          input.license.url ?? null,
          providerCategories,
          input.license.redistributionAllowed === true ? 1 : input.license.redistributionAllowed === false ? 0 : null,
          input.license.commercialUseAllowed === true ? 1 : input.license.commercialUseAllowed === false ? 0 : null,
          sourceMetadata,
          input.metadataFingerprint ?? null,
          allowed ? 1 : 0,
          stage,
          status,
          now,
          now,
        );
    });
    return this.getAsset(input)!;
  }

  getAsset(identity: CorpusAssetIdentity): CorpusAsset | null {
    validateIdentity(identity);
    const found = row(
      this.database
        .prepare("SELECT * FROM assets WHERE source = ? AND source_asset_id = ?")
        .get(identity.source, identity.sourceAssetId),
    );
    return found ? this.mapAsset(found) : null;
  }

  listAssets(query: CorpusAssetQuery = {}): CorpusAsset[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.source !== undefined) {
      conditions.push("a.source = ?");
      params.push(query.source);
    }
    if (query.sourceAssetId !== undefined) {
      conditions.push("a.source_asset_id = ?");
      params.push(query.sourceAssetId);
    }
    if (query.stage !== undefined) {
      conditions.push("a.stage = ?");
      params.push(query.stage);
    }
    if (query.status !== undefined) {
      conditions.push("a.status = ?");
      params.push(query.status);
    }
    if (query.licenseAllowed !== undefined) {
      conditions.push("a.license_allowed = ?");
      params.push(query.licenseAllowed ? 1 : 0);
    }
    if (query.classificationVersion !== undefined) {
      conditions.push("c.classification_version = ?");
      params.push(query.classificationVersion);
    }
    if (query.classificationLabels !== undefined) {
      for (const [label, expected] of Object.entries(query.classificationLabels)) {
        assertNonEmpty(label, "classification label query key");
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(c.labels_json) AS label_filter WHERE label_filter.key = ? AND label_filter.value IS ?)",
        );
        params.push(label, expected === true ? 1 : expected === false ? 0 : expected);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit === undefined ? 1000 : this.validateLimit(query.limit);
    const offset = query.offset === undefined ? 0 : this.validateOffset(query.offset);
    const results = this.database
      .prepare(
        `SELECT a.* FROM assets a
         LEFT JOIN classifications c ON c.source = a.source AND c.source_asset_id = a.source_asset_id
         ${where}
         ORDER BY a.source, a.source_asset_id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return results.map((value) => this.mapAsset(value as SqlRow));
  }

  listRetryable(query: RetryableQuery = {}): CorpusAsset[] {
    const now = query.now ?? new Date().toISOString();
    validateTimestamp(now, "now");
    const limit = query.limit === undefined ? 100 : this.validateLimit(query.limit);
    const results = this.database
      .prepare(
        `SELECT * FROM assets
         WHERE license_allowed = 1 AND status = 'failed' AND (retry_at IS NULL OR retry_at <= ?)
         ORDER BY CASE WHEN retry_at IS NULL THEN 0 ELSE 1 END, retry_at, updated_at
         LIMIT ?`,
      )
      .all(now, limit);
    return results.map((value) => this.mapAsset(value as SqlRow));
  }

  setStage(identity: CorpusAssetIdentity, stage: CorpusStage, status: CorpusStatus): CorpusAsset {
    this.requireAllowedAsset(identity);
    this.database
      .prepare("UPDATE assets SET stage = ?, status = ?, updated_at = ? WHERE source = ? AND source_asset_id = ?")
      .run(stage, status, new Date().toISOString(), identity.source, identity.sourceAssetId);
    return this.getAsset(identity)!;
  }

  recordFailure(identity: CorpusAssetIdentity, input: RecordFailureInput): CorpusAsset {
    this.requireAllowedAsset(identity);
    assertNonEmpty(input.kind, "failure.kind");
    assertNonEmpty(input.message, "failure.message");
    if (input.retryAt) validateTimestamp(input.retryAt, "failure.retryAt");
    const existing = this.requireAssetRow(identity);
    const attempt = existing.failure_stage === input.stage ? numberValue(existing.failure_attempt) + 1 : 1;
    const failedAt = input.failedAt ?? new Date().toISOString();
    validateTimestamp(failedAt, "failure.failedAt");
    this.database
      .prepare(
        `UPDATE assets SET stage = ?, status = 'failed', failure_stage = ?, failure_kind = ?,
         failure_message = ?, failure_attempt = ?, failed_at = ?, retry_at = ?, updated_at = ?
         WHERE source = ? AND source_asset_id = ?`,
      )
      .run(
        input.stage,
        input.stage,
        input.kind,
        input.message,
        attempt,
        failedAt,
        input.retryAt ?? null,
        failedAt,
        identity.source,
        identity.sourceAssetId,
      );
    return this.getAsset(identity)!;
  }

  recordVerifiedArtifact(identity: CorpusAssetIdentity, input: VerifiedArtifactInput): ArtifactWriteResult {
    this.requireAllowedAsset(identity);
    assertNonEmpty(input.path, "artifact.path");
    assertNonEmpty(input.filename, "artifact.filename");
    assertNonEmpty(input.sourceName, "artifact.sourceName");
    assertNonEmpty(input.format, "artifact.format");
    assertNonEmpty(input.sourceUrl, "artifact.sourceUrl");
    if (!/^[a-f\d]{64}$/i.test(input.sha256)) {
      throw new CorpusStoreError("artifact.sha256 must be a 64-character SHA-256 hex digest");
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
      throw new CorpusStoreError("artifact.byteSize must be a positive safe integer");
    }
    validateTimestamp(input.downloadedAt, "artifact.downloadedAt");
    if (input.kind === "raw" && input.immutable !== true) {
      throw new CorpusStoreError("Raw artifacts must be marked immutable");
    }
    if (input.parentSha256 && !/^[a-f\d]{64}$/i.test(input.parentSha256)) {
      throw new CorpusStoreError("artifact.parentSha256 must be a 64-character SHA-256 hex digest");
    }

    let output: ArtifactWriteResult | null = null;
    this.transaction(() => {
      const assetRow = this.requireAssetRow(identity);
      const asset = this.mapAsset(assetRow);
      const blobRow = row(
        this.database.prepare("SELECT byte_size, path FROM content_blobs WHERE sha256 = ?").get(input.sha256.toLowerCase()),
      );
      if (blobRow && numberValue(blobRow.byte_size) !== input.byteSize) {
        throw new CorpusStoreError("A content hash is already recorded with a conflicting byte size");
      }
      const canonicalPath = blobRow ? stringValue(blobRow.path) : input.path;
      const existingArtifact = row(
        this.database
          .prepare(
            `SELECT * FROM artifacts WHERE source = ? AND source_asset_id = ? AND kind = ? AND sha256 = ?`,
          )
          .get(identity.source, identity.sourceAssetId, input.kind, input.sha256.toLowerCase()),
      );
      if (!blobRow) {
        this.database
          .prepare("INSERT INTO content_blobs (sha256, byte_size, path, first_seen_at) VALUES (?, ?, ?, ?)")
          .run(input.sha256.toLowerCase(), input.byteSize, input.path, input.downloadedAt);
      }
      let artifactRow = existingArtifact;
      if (!artifactRow) {
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO artifacts (
              id, source, source_asset_id, kind, path, filename, source_name, format,
              sha256, byte_size, source_url, attribution, attribution_url, license_id,
              license_name, license_url, license_redistribution_allowed,
              license_commercial_allowed, downloaded_at, immutable, parent_sha256,
              conversion_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            identity.source,
            identity.sourceAssetId,
            input.kind,
            canonicalPath,
            input.filename,
            input.sourceName,
            input.format,
            input.sha256.toLowerCase(),
            input.byteSize,
            input.sourceUrl,
            input.attribution ?? asset.attribution ?? null,
            input.attributionUrl ?? asset.attributionUrl ?? null,
            asset.license.id,
            asset.license.name ?? null,
            asset.license.url ?? null,
            asset.license.redistributionAllowed === true ? 1 : asset.license.redistributionAllowed === false ? 0 : null,
            asset.license.commercialUseAllowed === true ? 1 : asset.license.commercialUseAllowed === false ? 0 : null,
            input.downloadedAt,
            input.immutable === true ? 1 : 0,
            input.parentSha256?.toLowerCase() ?? null,
            input.conversionVersion ?? null,
          );
        artifactRow = row(this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id));
      }
      if (!artifactRow) throw new CorpusStoreError("Failed to persist artifact reference");
      if (input.kind === "raw") {
        this.database
          .prepare(
            `UPDATE assets SET stage = 'inspection', status = 'pending', updated_at = ?
             WHERE source = ? AND source_asset_id = ?`,
          )
          .run(input.downloadedAt, identity.source, identity.sourceAssetId);
      }
      const artifact = this.mapArtifact(artifactRow);
      output = {
        artifact,
        deduplicated: Boolean(blobRow || existingArtifact),
        canonicalPath: artifact.path,
      };
    });
    if (!output) throw new CorpusStoreError("Failed to record verified artifact");
    return output;
  }

  listArtifacts(identity: CorpusAssetIdentity): ArtifactReference[] {
    validateIdentity(identity);
    const results = this.database
      .prepare(
        "SELECT * FROM artifacts WHERE source = ? AND source_asset_id = ? ORDER BY downloaded_at, id",
      )
      .all(identity.source, identity.sourceAssetId);
    return results.map((value) => this.mapArtifact(value as SqlRow));
  }

  recordInspection(identity: CorpusAssetIdentity, input: InspectionRecord): CorpusAsset {
    this.requireAllowedAsset(identity);
    if (!/^[a-f\d]{64}$/i.test(input.inputSha256)) {
      throw new CorpusStoreError("inspection.inputSha256 must be a 64-character SHA-256 hex digest");
    }
    assertNonEmpty(input.inspectorVersion, "inspection.inspectorVersion");
    assertNonEmpty(input.fingerprintVersion, "inspection.fingerprintVersion");
    validateTimestamp(input.inspectedAt, "inspection.inspectedAt");
    const fingerprint = ensureJsonObject(input.fingerprint, "inspection.fingerprint");
    const inputSha256 = input.inputSha256.toLowerCase();
    const raw = this.database
      .prepare(
        "SELECT 1 AS found FROM artifacts WHERE source = ? AND source_asset_id = ? AND kind = 'raw' AND sha256 = ? LIMIT 1",
      )
      .get(identity.source, identity.sourceAssetId, inputSha256);
    if (!raw) throw new CorpusStoreError("Inspection inputSha256 must match a verified raw artifact for this asset");
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO inspections (
            source, source_asset_id, input_sha256, inspector_version, fingerprint_version, fingerprint_json, inspected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, source_asset_id) DO UPDATE SET
            input_sha256 = excluded.input_sha256,
            inspector_version = excluded.inspector_version,
            fingerprint_version = excluded.fingerprint_version,
            fingerprint_json = excluded.fingerprint_json,
            inspected_at = excluded.inspected_at`,
        )
        .run(
          identity.source,
          identity.sourceAssetId,
          inputSha256,
          input.inspectorVersion,
          input.fingerprintVersion,
          serializeJson(fingerprint, "inspection.fingerprint"),
          input.inspectedAt,
        );
      this.database
        .prepare("DELETE FROM classifications WHERE source = ? AND source_asset_id = ?")
        .run(identity.source, identity.sourceAssetId);
      this.database
        .prepare(
          `UPDATE assets SET stage = 'classification', status = 'pending', updated_at = ?
           WHERE source = ? AND source_asset_id = ?`,
        )
        .run(input.inspectedAt, identity.source, identity.sourceAssetId);
    });
    return this.getAsset(identity)!;
  }

  recordClassification(identity: CorpusAssetIdentity, input: ClassificationRecord): CorpusAsset {
    this.requireAllowedAsset(identity);
    assertNonEmpty(input.classificationVersion, "classification.classificationVersion");
    validateTimestamp(input.classifiedAt, "classification.classifiedAt");
    const labels = ensureJsonObject(input.labels, "classification.labels");
    const inspection = this.database
      .prepare("SELECT 1 AS found FROM inspections WHERE source = ? AND source_asset_id = ?")
      .get(identity.source, identity.sourceAssetId);
    if (!inspection) throw new CorpusStoreError("Classification requires a recorded inspection");
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO classifications (source, source_asset_id, classification_version, labels_json, classified_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source, source_asset_id) DO UPDATE SET
             classification_version = excluded.classification_version,
             labels_json = excluded.labels_json,
             classified_at = excluded.classified_at`,
        )
        .run(
          identity.source,
          identity.sourceAssetId,
          input.classificationVersion,
          serializeJson(labels, "classification.labels"),
          input.classifiedAt,
        );
      this.database
        .prepare("UPDATE assets SET stage = 'complete', status = 'succeeded', updated_at = ? WHERE source = ? AND source_asset_id = ?")
        .run(input.classifiedAt, identity.source, identity.sourceAssetId);
    });
    return this.getAsset(identity)!;
  }

  private initializeSchema(): void {
    let version = numberValue(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version > SCHEMA_VERSION) {
      throw new CorpusStoreError(`Corpus database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (version === SCHEMA_VERSION) return;
    if (version === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE inspections ADD COLUMN input_sha256 TEXT NOT NULL DEFAULT '';
        UPDATE assets SET stage = 'inspection', status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE license_allowed = 1 AND EXISTS (
          SELECT 1 FROM inspections
          WHERE inspections.source = assets.source
            AND inspections.source_asset_id = assets.source_asset_id
        );
        DELETE FROM classifications;
        DELETE FROM inspections;
        PRAGMA user_version = 2;
        COMMIT;
      `);
      version = 2;
    }
    if (version === 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN author TEXT;
        PRAGMA user_version = 3;
        COMMIT;
      `);
      version = 3;
    }
    if (version === SCHEMA_VERSION) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS assets (
        source TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        author TEXT,
        description TEXT,
        source_url TEXT NOT NULL,
        attribution TEXT,
        attribution_url TEXT,
        license_id TEXT NOT NULL,
        license_name TEXT,
        license_url TEXT,
        license_redistribution_allowed INTEGER CHECK (license_redistribution_allowed IN (0, 1) OR license_redistribution_allowed IS NULL),
        license_commercial_allowed INTEGER CHECK (license_commercial_allowed IN (0, 1) OR license_commercial_allowed IS NULL),
        provider_categories_json TEXT NOT NULL,
        source_metadata_json TEXT NOT NULL,
        metadata_fingerprint TEXT,
        license_allowed INTEGER NOT NULL CHECK (license_allowed IN (0, 1)),
        stage TEXT NOT NULL CHECK (stage IN ('discovery', 'metadata', 'download', 'hash', 'conversion', 'inspection', 'classification', 'complete')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'blocked')),
        failure_stage TEXT,
        failure_kind TEXT,
        failure_message TEXT,
        failure_attempt INTEGER NOT NULL DEFAULT 0,
        failed_at TEXT,
        retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, source_asset_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS content_blobs (
        sha256 TEXT PRIMARY KEY,
        byte_size INTEGER NOT NULL,
        path TEXT NOT NULL,
        first_seen_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        source_name TEXT NOT NULL,
        format TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        attribution TEXT,
        attribution_url TEXT,
        license_id TEXT NOT NULL,
        license_name TEXT,
        license_url TEXT,
        license_redistribution_allowed INTEGER CHECK (license_redistribution_allowed IN (0, 1) OR license_redistribution_allowed IS NULL),
        license_commercial_allowed INTEGER CHECK (license_commercial_allowed IN (0, 1) OR license_commercial_allowed IS NULL),
        downloaded_at TEXT NOT NULL,
        immutable INTEGER NOT NULL CHECK (immutable IN (0, 1)),
        parent_sha256 TEXT,
        conversion_version TEXT,
        FOREIGN KEY (source, source_asset_id) REFERENCES assets(source, source_asset_id) ON DELETE CASCADE,
        FOREIGN KEY (sha256) REFERENCES content_blobs(sha256),
        UNIQUE (source, source_asset_id, kind, sha256)
      );
      CREATE INDEX IF NOT EXISTS artifacts_sha256_idx ON artifacts(sha256);
      CREATE TABLE IF NOT EXISTS inspections (
        source TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        inspector_version TEXT NOT NULL,
        fingerprint_version TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL,
        inspected_at TEXT NOT NULL,
        PRIMARY KEY (source, source_asset_id),
        FOREIGN KEY (source, source_asset_id) REFERENCES assets(source, source_asset_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS classifications (
        source TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        classification_version TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        classified_at TEXT NOT NULL,
        PRIMARY KEY (source, source_asset_id),
        FOREIGN KEY (source, source_asset_id) REFERENCES assets(source, source_asset_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS assets_retry_idx ON assets(status, retry_at, updated_at);
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }

  private transaction<T>(run: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      this.database.exec("ROLLBACK;");
      if (cause instanceof CorpusStoreError || cause instanceof CorpusLicenseError) throw cause;
      throw new CorpusStoreError("Corpus database transaction failed", { cause });
    }
  }

  private requireAssetRow(identity: CorpusAssetIdentity): SqlRow {
    validateIdentity(identity);
    const asset = row(
      this.database
        .prepare("SELECT * FROM assets WHERE source = ? AND source_asset_id = ?")
        .get(identity.source, identity.sourceAssetId),
    );
    if (!asset) throw new CorpusStoreError(`Unknown corpus asset ${identity.source}/${identity.sourceAssetId}`);
    return asset;
  }

  private requireAllowedAsset(identity: CorpusAssetIdentity): SqlRow {
    const asset = this.requireAssetRow(identity);
    if (!booleanValue(asset.license_allowed)) {
      throw new CorpusLicenseError(identity, stringValue(asset.license_id));
    }
    return asset;
  }

  private mapAsset(value: SqlRow): CorpusAsset {
    const license = {
      id: stringValue(value.license_id),
      name: nullableString(value.license_name),
      url: nullableString(value.license_url),
      redistributionAllowed:
        value.license_redistribution_allowed === null || value.license_redistribution_allowed === undefined
          ? null
          : booleanValue(value.license_redistribution_allowed),
      commercialUseAllowed:
        value.license_commercial_allowed === null || value.license_commercial_allowed === undefined
          ? null
          : booleanValue(value.license_commercial_allowed),
    };
    let failure: CorpusFailure | null = null;
    if (value.failure_stage !== null && value.failure_stage !== undefined) {
      failure = {
        stage: stringValue(value.failure_stage) as CorpusStage,
        kind: stringValue(value.failure_kind),
        message: stringValue(value.failure_message),
        attempt: numberValue(value.failure_attempt),
        failedAt: stringValue(value.failed_at),
        retryAt: nullableString(value.retry_at),
      };
    }
    const inspectionRow = row(
      this.database
        .prepare("SELECT * FROM inspections WHERE source = ? AND source_asset_id = ?")
        .get(stringValue(value.source), stringValue(value.source_asset_id)),
    );
    const classificationRow = row(
      this.database
        .prepare("SELECT * FROM classifications WHERE source = ? AND source_asset_id = ?")
        .get(stringValue(value.source), stringValue(value.source_asset_id)),
    );
    const inspection: InspectionRecord | null = inspectionRow
      ? {
          inputSha256: stringValue(inspectionRow.input_sha256),
          inspectorVersion: stringValue(inspectionRow.inspector_version),
          fingerprintVersion: stringValue(inspectionRow.fingerprint_version),
          fingerprint: parseJson(inspectionRow.fingerprint_json, {}, "inspection fingerprint"),
          inspectedAt: stringValue(inspectionRow.inspected_at),
        }
      : null;
    const classification: ClassificationRecord | null = classificationRow
      ? {
          classificationVersion: stringValue(classificationRow.classification_version),
          labels: parseJson(classificationRow.labels_json, {}, "classification labels"),
          classifiedAt: stringValue(classificationRow.classified_at),
        }
      : null;
    return {
      source: stringValue(value.source),
      sourceAssetId: stringValue(value.source_asset_id),
      name: stringValue(value.name),
      author: nullableString(value.author),
      description: nullableString(value.description),
      sourceUrl: stringValue(value.source_url),
      attribution: nullableString(value.attribution),
      attributionUrl: nullableString(value.attribution_url),
      license,
      providerCategories: parseJson(value.provider_categories_json, [], "provider categories"),
      sourceMetadata: parseJson(value.source_metadata_json, {}, "source metadata"),
      ...(nullableString(value.metadata_fingerprint) ? { metadataFingerprint: stringValue(value.metadata_fingerprint) } : {}),
      licenseAllowed: booleanValue(value.license_allowed),
      stage: stringValue(value.stage) as CorpusStage,
      status: stringValue(value.status) as CorpusStatus,
      failure,
      inspection,
      classification,
      createdAt: stringValue(value.created_at),
      updatedAt: stringValue(value.updated_at),
    };
  }

  private mapArtifact(value: SqlRow): ArtifactReference {
    return {
      id: stringValue(value.id),
      source: stringValue(value.source),
      sourceAssetId: stringValue(value.source_asset_id),
      kind: stringValue(value.kind) as ArtifactReference["kind"],
      path: stringValue(value.path),
      filename: stringValue(value.filename),
      sourceName: stringValue(value.source_name),
      format: stringValue(value.format),
      sha256: stringValue(value.sha256),
      byteSize: numberValue(value.byte_size),
      sourceUrl: stringValue(value.source_url),
      attribution: nullableString(value.attribution),
      attributionUrl: nullableString(value.attribution_url),
      license: {
        id: stringValue(value.license_id),
        name: nullableString(value.license_name),
        url: nullableString(value.license_url),
        redistributionAllowed:
          value.license_redistribution_allowed === null || value.license_redistribution_allowed === undefined
            ? null
            : booleanValue(value.license_redistribution_allowed),
        commercialUseAllowed:
          value.license_commercial_allowed === null || value.license_commercial_allowed === undefined
            ? null
            : booleanValue(value.license_commercial_allowed),
      },
      downloadedAt: stringValue(value.downloaded_at),
      immutable: booleanValue(value.immutable),
      parentSha256: nullableString(value.parent_sha256),
      conversionVersion: nullableString(value.conversion_version),
    };
  }

  private validateLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
      throw new CorpusStoreError("limit must be an integer from 1 through 10000");
    }
    return value;
  }

  private validateOffset(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new CorpusStoreError("offset must be a non-negative integer");
    return value;
  }
}

export { type CorpusAssetIdentity } from "./domain";
