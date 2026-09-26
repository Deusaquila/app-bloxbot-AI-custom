import { describe, expect, it } from "vitest";
import { matchesScale, matchesColor } from "./V1JobRunner";
import { parseRobloxFingerprint, readStudioJson } from "./RobloxServiceLive";
import { compileKnownV1Task } from "../control/TaskCompiler";
import type { AssetFingerprint } from "../../src/types/asset";
const fingerprint = {
  objects: 1,
  materials: 1,
  dimensions: { x: 2, y: 4, z: 6 },
  hierarchyValid: true,
  colors: [[0, 0, 0, 1]],
  texturedParts: 0,
};
describe("V1 ground-truth checks", () => {
  it("checks every axis instead of an average", () => {
    expect(matchesScale({ x: 1, y: 2, z: 3 }, { x: 2, y: 4, z: 6 }, 2)).toBe(true);
    expect(matchesScale({ x: 1, y: 2, z: 3 }, { x: 1, y: 4, z: 9 }, 2)).toBe(false);
    expect(matchesScale({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2)).toBe(false);
  });
  it("does not accept texture-covered or partially black models", () => {
    expect(matchesColor(fingerprint, [0, 0, 0, 1])).toBe(true);
    expect(matchesColor({ ...fingerprint, texturedParts: 1 }, [0, 0, 0, 1])).toBe(false);
    expect(
      matchesColor(
        {
          ...fingerprint,
          colors: [
            [0, 0, 0, 1],
            [1, 0, 0, 1],
          ],
        },
        [0, 0, 0, 1],
      ),
    ).toBe(false);
  });
  it("rejects absent/malformed Studio evidence", () => {
    expect(() => readStudioJson({ isError: true, content: [] })).toThrow();
    expect(() => readStudioJson({ content: [{ type: "text", text: "nil" }] })).toThrow();
    expect(() =>
      parseRobloxFingerprint({ ...fingerprint, dimensions: { x: NaN, y: 2, z: 3 } }),
    ).toThrow();
    expect(() => parseRobloxFingerprint({ ...fingerprint, objects: 0 })).toThrow();
  });
  it("does not compile negated or partially understood tasks", () => {
    for (const prompt of [
      "Don't make it black and double the size",
      "Make it black and double the size and add wings",
    ]) {
      expect(compileKnownV1Task(prompt, {} as AssetFingerprint)).toBeUndefined();
    }
  });
});
