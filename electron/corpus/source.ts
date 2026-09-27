import type { DiscoveredAssetInput } from "./domain";

export interface SourceDiscoveryOptions {
  /** Optional cap for callers that deliberately want a smaller discovery set. */
  limit?: number;
}

/** Provider-neutral representation of metadata needed to register one corpus asset. */
export type SourceMetadata = DiscoveredAssetInput & { author?: string | null };

export type DownloadFileRole = "primary" | "dependency" | "alternative";

export interface DownloadFileOption {
  /** HTTPS URL returned by the source provider. */
  url: string;
  /** Safe path relative to the asset's download directory. Uses forward slashes. */
  relativePath: string;
  filename: string;
  format: string;
  size: number;
  md5: string | null;
  /** Optional provider-supplied SHA-256, when available. */
  sha256?: string | null;
  sourceUrl: string;
  role: DownloadFileRole;
}

export interface DownloadOptionsVariant {
  resolution: string;
  format: string;
  primary: DownloadFileOption;
  dependencies: DownloadFileOption[];
}

export interface DownloadOptions extends DownloadOptionsVariant {
  /** Other complete model packages exposed at the selected resolution. */
  alternatives: DownloadOptionsVariant[];
}

export interface CorpusSource {
  readonly sourceName: string;
  discover(options?: SourceDiscoveryOptions): Promise<SourceMetadata[]>;
  getMetadata(sourceAssetId: string): Promise<SourceMetadata>;
  getDownloadOptions(sourceAssetId: string): Promise<DownloadOptions>;
}

export interface DownloadedArtifact {
  path: string;
  filename: string;
  format: string;
  sourceUrl: string;
  sha256: string;
  byteSize: number;
  downloadedAt: string;
  skippedExisting: boolean;
}

export const DEFAULT_CORPUS_USER_AGENT = "BloxBotCorpusV1/1.0 (+https://bloxbot.ai)";
