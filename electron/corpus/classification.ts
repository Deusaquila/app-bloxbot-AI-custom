import type { AssetFingerprint } from "../../src/types/asset";

/** Bump this when a rule or threshold changes; stored labels are reproducible. */
export const CLASSIFICATION_VERSION = "corpus-technical-v1";

export interface TechnicalClassification {
  readonly meshCount: "single_mesh" | "multi_mesh" | null;
  readonly materialCount: "single_material" | "multi_material" | null;
  readonly texture: "textured" | "untextured" | null;
  readonly rig: "rigged" | "unrigged" | null;
  readonly roots: "single_root" | "multi_root" | null;
  readonly geometry: "simple_geometry" | "medium_geometry" | "complex_geometry" | null;
  readonly topology: "clean_topology" | "topology_warning" | null;
}

/** Technical labels only. Provider categories and semantic names are separate data. */
export function classifyFingerprint(fingerprint: AssetFingerprint): {
  version: string;
  labels: TechnicalClassification;
} {
  const textureStates = fingerprint.materials.map((material) => material.hasTextures);
  const textured = textureStates.some((state) => state === true);
  const texture = textured
    ? "textured"
    : textureStates.length > 0 && textureStates.every((state) => state === false)
      ? "untextured"
      : null;
  const roots = fingerprint.structure?.rootObjects;
  const manifoldRatio = fingerprint.topology.manifoldRatio;
  const loose = fingerprint.topology.looseGeometry;
  const topology =
    (manifoldRatio !== undefined && manifoldRatio < 1) || loose === true
      ? "topology_warning"
      : manifoldRatio === 1 && loose === false
        ? "clean_topology"
        : null;

  return {
    version: CLASSIFICATION_VERSION,
    labels: {
      meshCount:
        fingerprint.meshes === 1 ? "single_mesh" : fingerprint.meshes > 1 ? "multi_mesh" : null,
      materialCount:
        fingerprint.materials.length === 1
          ? "single_material"
          : fingerprint.materials.length > 1
            ? "multi_material"
            : null,
      texture,
      rig: fingerprint.rig.exists ? "rigged" : "unrigged",
      roots: roots === undefined || roots === 0 ? null : roots === 1 ? "single_root" : "multi_root",
      geometry:
        fingerprint.meshes === 0
          ? null
          : fingerprint.triangles <= 10_000
            ? "simple_geometry"
            : fingerprint.triangles <= 100_000
              ? "medium_geometry"
              : "complex_geometry",
      topology,
    },
  };
}
