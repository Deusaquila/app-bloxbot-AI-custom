// Compatibility export for existing transport callers.
import { RobloxOpenCloudAssetService, type OpenCloudOptions } from "./RobloxOpenCloudAssetService";
export type { OpenCloudOptions } from "./RobloxOpenCloudAssetService";
export async function uploadFbx(path: string, options: OpenCloudOptions): Promise<string> {
  return (await new RobloxOpenCloudAssetService(options).uploadFile(path)).assetId;
}
