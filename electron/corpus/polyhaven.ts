import { createHash } from "node:crypto";

import type { JsonObject } from "./domain";
import { assertSafeRelativePath } from "./download";
import { DEFAULT_CORPUS_USER_AGENT, type CorpusSource, type DownloadFileOption, type DownloadOptions, type DownloadOptionsVariant, type SourceDiscoveryOptions, type SourceMetadata } from "./source";

const POLY_HAVEN_SOURCE = "polyhaven";
const POLY_HAVEN_API = "https://api.polyhaven.com";
const POLY_HAVEN_ASSETS = "https://polyhaven.com/a";
const CC0_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
const DEFAULT_RESOLUTION = "1k";
const ALTERNATIVE_FORMATS = ["blend", "gltf", "glb", "obj", "usd"] as const;

type UnknownRecord = Record<string, unknown>;

export interface PolyHavenSourceOptions {
  apiBaseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PolyHavenSourceError extends Error {
  override name = "PolyHavenSourceError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  const properties = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${properties.join(",")}}`;
}

function asJsonObject(value: UnknownRecord): JsonObject {
  // JSON.parse is the trust boundary: API responses came from JSON and this
  // round trip excludes prototypes and non-JSON values from persisted metadata.
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function validateAssetId(sourceAssetId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sourceAssetId)) {
    throw new PolyHavenSourceError("Poly Haven asset IDs may contain only letters, numbers, underscores, and hyphens");
  }
}

function urlFilename(urlValue: string): string {
  let pathname: string;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.hostname !== "dl.polyhaven.org" || url.username || url.password) {
      throw new Error("Download URL must use the Poly Haven download host over HTTPS");
    }
    pathname = url.pathname;
  } catch (cause) {
    throw new PolyHavenSourceError("Poly Haven returned an invalid download URL", { cause });
  }
  const encodedFilename = pathname.slice(pathname.lastIndexOf("/") + 1);
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch (cause) {
    throw new PolyHavenSourceError("Poly Haven returned a malformed encoded filename", { cause });
  }
  assertSafeRelativePath(filename);
  if (filename.includes("/")) throw new PolyHavenSourceError("Poly Haven returned an invalid filename");
  return filename;
}

function formatFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "unknown" : filename.slice(dot + 1).toLowerCase();
}

function numericSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PolyHavenSourceError("Poly Haven file metadata is missing a valid size");
  }
  return value;
}

function fileOption(
  record: unknown,
  role: DownloadFileOption["role"],
  relativePath?: string,
): DownloadFileOption {
  if (!isRecord(record) || typeof record.url !== "string") {
    throw new PolyHavenSourceError("Poly Haven file metadata is missing a URL");
  }
  const url = record.url;
  const filename = urlFilename(url);
  const safeRelativePath = assertSafeRelativePath(relativePath ?? filename);
  const md5 = typeof record.md5 === "string" ? record.md5.toLowerCase() : null;
  if (md5 !== null && !/^[a-f0-9]{32}$/.test(md5)) {
    throw new PolyHavenSourceError("Poly Haven file metadata contains an invalid MD5 checksum");
  }
  return {
    url,
    relativePath: safeRelativePath,
    filename,
    format: formatFromFilename(filename),
    size: numericSize(record.size),
    md5,
    sourceUrl: url,
    role,
  };
}

function variantFromFiles(
  files: UnknownRecord,
  format: string,
  role: DownloadFileOption["role"],
  pathPrefix = "",
): DownloadOptionsVariant | null {
  const formatFiles = files[format];
  if (!isRecord(formatFiles)) return null;
  const resolutionFiles = formatFiles[DEFAULT_RESOLUTION];
  if (!isRecord(resolutionFiles)) return null;
  const mainRecord = resolutionFiles[format];
  if (!isRecord(mainRecord)) return null;

  const mainFilename = urlFilename(typeof mainRecord.url === "string" ? mainRecord.url : "");
  const mainPath = pathPrefix ? `${pathPrefix}/${mainFilename}` : mainFilename;
  const primary = fileOption(mainRecord, role, mainPath);
  const include = isRecord(mainRecord.include) ? mainRecord.include : {};
  const dependencies = Object.entries(include).map(([path, item]) => {
    const safeRelativePath = pathPrefix ? `${pathPrefix}/${path}` : path;
    return fileOption(item, "dependency", safeRelativePath);
  });
  return {
    resolution: DEFAULT_RESOLUTION,
    format,
    primary,
    dependencies,
  };
}

export class PolyHavenSource implements CorpusSource {
  readonly sourceName = POLY_HAVEN_SOURCE;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PolyHavenSourceOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? POLY_HAVEN_API;
    this.userAgent = options.userAgent ?? DEFAULT_CORPUS_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!this.userAgent.trim()) throw new PolyHavenSourceError("A unique User-Agent is required for Poly Haven API calls");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new PolyHavenSourceError("timeoutMs must be a positive integer");
    }
    try {
      const apiUrl = new URL(this.apiBaseUrl);
      if (apiUrl.protocol !== "https:") throw new Error("API base URL must use HTTPS");
      this.apiBaseUrl = apiUrl.toString().replace(/\/$/, "");
    } catch (cause) {
      throw new PolyHavenSourceError("A valid HTTPS Poly Haven API base URL is required", { cause });
    }
  }

  async discover(options: SourceDiscoveryOptions = {}): Promise<SourceMetadata[]> {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
      throw new PolyHavenSourceError("limit must be a non-negative integer");
    }
    const payload = await this.getJson("/assets?type=models");
    if (!isRecord(payload)) throw new PolyHavenSourceError("Poly Haven returned an invalid model list");
    const entries = Object.entries(payload)
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([, value]) => isRecord(value) && (value.type === undefined || value.type === 2))
      .map(([sourceAssetId, value]) => this.mapMetadata(sourceAssetId, value));
    return options.limit === undefined ? entries : entries.slice(0, options.limit);
  }

  async getMetadata(sourceAssetId: string): Promise<SourceMetadata> {
    validateAssetId(sourceAssetId);
    const payload = await this.getJson(`/info/${encodeURIComponent(sourceAssetId)}`);
    return this.mapMetadata(sourceAssetId, payload);
  }

  async getDownloadOptions(sourceAssetId: string): Promise<DownloadOptions> {
    validateAssetId(sourceAssetId);
    const payload = await this.getJson(`/files/${encodeURIComponent(sourceAssetId)}`);
    if (!isRecord(payload)) throw new PolyHavenSourceError("Poly Haven returned invalid file metadata");

    const primary = variantFromFiles(payload, "fbx", "primary");
    if (!primary) {
      throw new PolyHavenSourceError(`Poly Haven asset '${sourceAssetId}' has no ${DEFAULT_RESOLUTION} FBX file`);
    }
    const alternatives = ALTERNATIVE_FORMATS.flatMap((format) => {
      const variant = variantFromFiles(payload, format, "alternative", `alternatives/${format}`);
      return variant ? [variant] : [];
    });
    return { ...primary, alternatives };
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, `${this.apiBaseUrl}/`), {
        method: "GET",
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        throw new PolyHavenSourceError(
          `Poly Haven API returned HTTP ${response.status}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`,
        );
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof PolyHavenSourceError) throw cause;
      throw new PolyHavenSourceError("Poly Haven API request failed", { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  private mapMetadata(sourceAssetId: string, value: unknown): SourceMetadata {
    if (!isRecord(value)) throw new PolyHavenSourceError(`Poly Haven returned invalid metadata for '${sourceAssetId}'`);
    const sourceUrl = `${POLY_HAVEN_ASSETS}/${encodeURIComponent(sourceAssetId)}`;
    const canonicalCategory = stringOrNull(value.category);
    const legacyCategories = Array.isArray(value.categories)
      ? value.categories.filter((category): category is string => typeof category === "string")
      : [];
    const authorNames = isRecord(value.authors)
      ? Object.keys(value.authors).filter((author) => author.trim().length > 0)
      : [];
    const providerCategories = canonicalCategory
      ? canonicalCategory.split("/").map((category) => category.trim()).filter(Boolean)
      : legacyCategories;
    const metadata = asJsonObject(value);
    return {
      source: this.sourceName,
      sourceAssetId,
      name: typeof value.name === "string" && value.name.trim() ? value.name : sourceAssetId,
      description: stringOrNull(value.description),
      sourceUrl,
      author: authorNames.length ? authorNames.join(", ") : null,
      attribution: "Poly Haven",
      attributionUrl: sourceUrl,
      license: {
        id: "CC0",
        name: "CC0 1.0 Universal",
        url: CC0_LICENSE_URL,
        redistributionAllowed: true,
        commercialUseAllowed: true,
      },
      providerCategories,
      sourceMetadata: metadata,
      metadataFingerprint: createHash("sha256").update(stableStringify(metadata)).digest("hex"),
    };
  }
}
