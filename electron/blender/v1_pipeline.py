"""Deterministic V1 adapter. Every mutation writes a new scene; input is immutable."""
import bpy
import json
import math
import os
import sys
from mathutils import Vector


def meshes():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def dimensions():
    bpy.context.view_layer.update()
    points = [obj.matrix_world @ Vector(corner) for obj in meshes() for corner in obj.bound_box]
    if not points:
        raise ValueError("Asset contains no meshes")
    return {axis: max(getattr(p, axis) for p in points) - min(getattr(p, axis) for p in points)
            for axis in ("x", "y", "z")}


def color(material):
    if material is None:
        return None
    if material.use_nodes:
        shaders = [n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]
        if len(shaders) != 1 or shaders[0].inputs["Base Color"].is_linked:
            return None
        return list(shaders[0].inputs["Base Color"].default_value)
    return list(material.diffuse_color)


def inspect():
    objects = meshes()
    for obj in objects:
        obj.data.calc_loop_triangles()
    materials = {m.name: m for obj in objects for m in obj.data.materials if m is not None}
    return {
        "assetId": request["assetId"], "format": "fbx",
        "objects": len(bpy.context.scene.objects), "meshes": len(objects),
        "vertices": sum(len(obj.data.vertices) for obj in objects),
        "triangles": sum(len(obj.data.loop_triangles) for obj in objects),
        "materials": [{"name": m.name, **({"baseColor": color(m)} if color(m) is not None else {})}
                      for m in materials.values()],
        "dimensions": dimensions(),
        "transforms": {"scale": [1, 1, 1], "rotation": [0, 0, 0]},
        "rig": {"exists": any(obj.type == "ARMATURE" for obj in bpy.context.scene.objects),
                "bones": sum(len(obj.data.bones) for obj in bpy.context.scene.objects if obj.type == "ARMATURE")},
        "topology": {}, "issues": [],
    }


def valid_rgba(value):
    return isinstance(value, list) and len(value) == 4 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 1 for v in value)


def execute():
    source = request["assetPath"]
    if source.lower().endswith(".blend"):
        bpy.ops.wm.open_mainfile(filepath=source)
    elif source.lower().endswith(".fbx"):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=source)
    else:
        raise ValueError("Only FBX and derived Blender scenes are supported")
    if not meshes():
        raise ValueError("Asset contains no meshes")
    capability = request["capability"]
    payload = request.get("input", {})
    if capability == "asset.inspect":
        return inspect()
    if capability == "material.set_base_color":
        rgba = payload["expected"]
        if not valid_rgba(rgba):
            raise ValueError("Expected finite RGBA channels in [0,1]")
        # A uniform material replaces texture/shader inputs so the requested color is objective.
        material = bpy.data.materials.new(name="BloxBotUniformMaterial")
        material.diffuse_color = rgba
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = rgba
        shader.inputs["Alpha"].default_value = rgba[3]
        for obj in meshes():
            obj.data = obj.data.copy()
            obj.data.materials.clear()
            obj.data.materials.append(material)
            for polygon in obj.data.polygons:
                polygon.material_index = 0
    elif capability == "transform.scale_uniform":
        factor = payload["expected"]
        if isinstance(factor, bool) or not isinstance(factor, (float, int)) or not math.isfinite(factor) or factor <= 0:
            raise ValueError("Scale must be finite and positive")
        # Scale translation as well as dimensions, including separated root objects.
        from mathutils import Matrix
        transform = Matrix.Scale(factor, 4)
        for obj in bpy.context.scene.objects:
            if obj.parent is None:
                obj.matrix_world = transform @ obj.matrix_world
    elif capability == "asset.verify_material":
        expected = payload["expected"]
        if not valid_rgba(expected):
            raise ValueError("Invalid expected color")
        colors = [color(m) for obj in meshes() for m in obj.data.materials]
        valid = all(len(obj.data.materials) > 0 for obj in meshes()) and bool(colors) and all(
            c is not None and all(abs(a-b) <= 1e-5 for a, b in zip(c, expected)) for c in colors)
        return {"valid": valid, "colors": colors}
    elif capability == "asset.verify_dimensions":
        return {"dimensions": dimensions()}
    elif capability == "asset.export_fbx":
        destination = payload["destination"]
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        bpy.ops.export_scene.fbx(filepath=destination, use_selection=False, object_types={'MESH', 'ARMATURE', 'EMPTY'},
                                 add_leaf_bones=False, bake_anim=False, axis_forward='-Z', axis_up='Y')
        return {"path": destination, "fingerprint": inspect()}
    else:
        raise ValueError("Unsupported Blender capability: " + capability)
    bpy.context.view_layer.update()
    destination = request["scenePath"]
    bpy.ops.wm.save_as_mainfile(filepath=destination)
    return {"path": destination, "fingerprint": inspect()}


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 2:
        raise ValueError("Expected request and response paths")
    with open(args[0], encoding="utf-8-sig") as handle:
        request = json.load(handle)
    result = execute()
    temporary = args[1] + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(result, handle, allow_nan=False)
    os.replace(temporary, args[1])
