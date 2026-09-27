import type { DiscoveredAssetInput } from "./domain";

/** Select a reproducible cross-section of source categories before a limited ingest. */
export function selectDiverseAssets(
  discovered: readonly DiscoveredAssetInput[],
  limit: number,
): DiscoveredAssetInput[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
  if (limit === 0) return [];

  const unique = new Map<string, DiscoveredAssetInput>();
  for (const asset of discovered) {
    const key = JSON.stringify([asset.source, asset.sourceAssetId]);
    if (!unique.has(key)) unique.set(key, asset);
  }
  const groups = new Map<string, DiscoveredAssetInput[]>();
  for (const asset of unique.values()) {
    const category = asset.providerCategories?.[0]?.split("/")[0]?.trim() || "Uncategorized";
    const group = groups.get(category) ?? [];
    group.push(asset);
    groups.set(category, group);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, assets]) => assets.sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId)));
  const result: DiscoveredAssetInput[] = [];
  let offset = 0;
  while (result.length < limit) {
    let added = false;
    for (const group of orderedGroups) {
      if (offset < group.length) {
        result.push(group[offset]);
        added = true;
        if (result.length === limit) break;
      }
    }
    if (!added) break;
    offset += 1;
  }
  return result;
}
