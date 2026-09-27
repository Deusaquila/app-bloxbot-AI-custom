import { describe, expect, it } from "vitest";
import type { DiscoveredAssetInput } from "./domain";
import { selectDiverseAssets } from "./selection";

const asset = (id: string, category: string): DiscoveredAssetInput => ({
  source: "polyhaven",
  sourceAssetId: id,
  sourceUrl: `https://polyhaven.com/a/${id}`,
  name: id,
  license: { id: "CC0", redistributionAllowed: true, commercialUseAllowed: true },
  providerCategories: [category],
});

describe("balanced corpus selection", () => {
  it("selects across source categories deterministically and deduplicates discovery", () => {
    const input = [asset("a", "Furniture/Chairs"), asset("b", "Furniture/Tables"), asset("a", "Furniture/Chairs"), asset("d", "Nature/Trees"), asset("c", "Industrial/Tools")];
    expect(selectDiverseAssets(input, 3).map((item) => item.sourceAssetId)).toEqual(["a", "c", "d"]);
    expect(selectDiverseAssets(input.slice().reverse(), 3).map((item) => item.sourceAssetId)).toEqual(["a", "c", "d"]);
  });
});
