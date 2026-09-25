"""Deterministic Blender worker for the V1 asset capabilities.

The process is intentionally one-request/one-response.  A persistent .blend file is
the state passed between invocations; this prevents later operations from silently
re-importing the original FBX and losing earlier edits.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Vector


def fail(message):
    raise ValueError(message)


def require_path(value, name):
    if not isinstance(value, str) or not value.strip():
        fail(name + " must be a non-empty path")
    return os.path.abspath(value)


def mesh_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def world_dimensions():
    points = [obj.matrix_world @ Vector(corner) for obj in mesh_objects() for corner in obj.bound_box]
    if not points:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    return {
        axis: max(getattr(point, axis) for point in points) - min(getattr(point, axis) for point in points)
        for axis in ("x", "y", "z")
    }


def rgba(value):
    if not isinstance(value, list) or len(value) != 4:
        fail("expected must be an RGBA array")
    result = [float(component) for component in value]
    if not all(math.isfinite(component) and 0 <= component <= 1 for component in result):
        fail("RGBA components must be finite values between 0 and 1")
    return result


def materials_for_meshes():
    return [material for obj in mesh_objects() for material in obj.data.materials if material is not None]


def inspect_asset():
    meshes = mesh_objects()
    for obj in meshes:
        obj.data.calc_loop_triangles()
    materials = materials_for_meshes()
    return {
        "format": "fbx",
        "objects": len(bpy.context.scene.objects),
        "meshes": len(meshes),
        "vertices": sum(len(obj.data.vertices) for obj in meshes),
        "triangles": sum(len(obj.data.loop_triangles) for obj in meshes),
        "materials": [{"name": material.name, "baseColor": list(material.diffuse_color)} for material in materials],
        "dimensions": world_dimensions(),
        "transforms": {"scale": [1, 1, 1], "rotation": [0, 0, 0]},
        "rig": {
            "exists": any(obj.type == "ARMATURE" for obj in bpy.context.scene.objects),
            "bones": sum(len(obj.data.bones) for obj in bpy.context.scene.objects if obj.type == "ARMATURE"),
        },
        "topology": {},
        "issues": [] if meshes else [{"code": "NO_MESH", "severity": "ERROR", "message": "FBX contains no mesh objects"}],
    }


def load_state(request):
    scene_path = require_path(request.get("scenePath"), "scenePath")
    if os.path.isfile(scene_path):
        bpy.ops.wm.open_mainfile(filepath=scene_path)
        return scene_path
    asset_path = require_path(request.get("assetPath"), "assetPath")
    if not os.path.isfile(asset_path):
        fail("assetPath does not exist")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=asset_path)
    if not mesh_objects():
        fail("FBX import produced no mesh objects")
    os.makedirs(os.path.dirname(scene_path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=scene_path)
    return scene_path


def save(scene_path):
    bpy.ops.wm.save_as_mainfile(filepath=scene_path)


def set_material_color(material, expected):
    changed = any(abs(a - b) > 1e-6 for a, b in zip(material.diffuse_color, expected))
    material.diffuse_color = expected
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                base_color = node.inputs.get("Base Color")
                if base_color is not None:
                    changed = changed or any(abs(a - b) > 1e-6 for a, b in zip(base_color.default_value, expected))
                    base_color.default_value = expected
    return changed


def main():
    try:
        separator = sys.argv.index("--")
    except ValueError:
        fail("Expected request and response paths after --")
    args = sys.argv[separator + 1:]
    if len(args) != 2:
        fail("Expected exactly two arguments: request path and response path")
    request_path, response_path = map(os.path.abspath, args)
    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    if not isinstance(request, dict):
        fail("Request must be an object")

    scene_path = load_state(request)
    capability = request.get("capability")
    payload = request.get("input") or {}
    if not isinstance(payload, dict):
        fail("input must be an object")

    if capability == "asset.inspect":
        result = inspect_asset()
    elif capability == "material.set_base_color":
        expected = rgba(payload.get("expected"))
        changed = False
        for obj in mesh_objects():
            if not obj.data.materials:
                material = bpy.data.materials.new(name="BloxBotMaterial")
                material.use_nodes = True
                obj.data.materials.append(material)
            for material in obj.data.materials:
                if material is not None:
                    changed = set_material_color(material, expected) or changed
        save(scene_path)
        result = {"changed": changed, "observed": expected}
    elif capability == "transform.scale_uniform":
        factor = float(payload.get("expected"))
        if not math.isfinite(factor) or factor <= 0:
            fail("Scale factor must be finite and positive")
        before = world_dimensions()
        for obj in bpy.context.scene.objects:
            if obj.parent is None:
                obj.scale = tuple(component * factor for component in obj.scale)
        bpy.context.view_layer.update()
        after = world_dimensions()
        save(scene_path)
        result = {"changed": factor != 1, "factor": factor, "before": before, "after": after}
    elif capability == "asset.verify_material":
        expected = rgba(payload.get("expected"))
        materials = materials_for_meshes()
        valid = bool(materials) and all(
            all(abs(a - b) <= 1e-5 for a, b in zip(material.diffuse_color, expected)) for material in materials
        )
        result = {"valid": valid, "expected": expected, "materialCount": len(materials)}
    elif capability == "asset.verify_dimensions":
        baseline = payload.get("baselineDimensions")
        expected = float(payload.get("expected"))
        observed = world_dimensions()
        ratios = []
        if isinstance(baseline, dict):
            for axis in ("x", "y", "z"):
                original = float(baseline.get(axis, 0))
                if original > 0:
                    ratios.append(observed[axis] / original)
        ratio = sum(ratios) / len(ratios) if ratios else None
        result = {"valid": ratio is not None and abs(ratio - expected) <= 0.01, "factor": ratio, "dimensions": observed}
    elif capability == "asset.export_fbx":
        destination = require_path(payload.get("destination"), "input.destination")
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        bpy.ops.export_scene.fbx(filepath=destination, use_selection=False)
        if not os.path.isfile(destination) or os.path.getsize(destination) == 0:
            fail("FBX export did not produce a non-empty file")
        result = {"path": destination, "bytes": os.path.getsize(destination)}
    else:
        fail("Unsupported Blender capability: " + str(capability))

    os.makedirs(os.path.dirname(response_path), exist_ok=True)
    with open(response_path, "w", encoding="utf-8") as handle:
        json.dump({"ok": True, "capability": capability, "value": result}, handle)


if __name__ == "__main__":
    main()
