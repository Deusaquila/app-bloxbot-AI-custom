import bpy
import json
import os
import sys

args = sys.argv[sys.argv.index("--") + 1:]
request_path, response_path = args
with open(request_path, "r", encoding="utf-8") as handle:
    request = json.load(handle)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def import_fbx(path):
    reset()
    bpy.ops.import_scene.fbx(filepath=path)

def meshes():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]

def dimensions():
    points = []
    for obj in meshes():
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ __import__("mathutils").Vector(corner))
    if not points:
        return {"x": 0, "y": 0, "z": 0}
    return {
        "x": max(p.x for p in points) - min(p.x for p in points),
        "y": max(p.y for p in points) - min(p.y for p in points),
        "z": max(p.z for p in points) - min(p.z for p in points),
    }

def inspect():
    mesh_objects = meshes()
    materials = []
    for material in bpy.data.materials:
        materials.append({
            "name": material.name,
            "baseColor": list(material.diffuse_color),
        })
    return {
        "format": "fbx",
        "objects": len(bpy.context.scene.objects),
        "meshes": len(mesh_objects),
        "vertices": sum(len(obj.data.vertices) for obj in mesh_objects),
        "triangles": sum(len(obj.data.loop_triangles) for obj in mesh_objects),
        "materials": materials,
        "dimensions": dimensions(),
        "transforms": {"scale": [1, 1, 1], "rotation": [0, 0, 0]},
        "rig": {
            "exists": any(obj.type == "ARMATURE" for obj in bpy.context.scene.objects),
            "bones": sum(len(obj.data.bones) for obj in bpy.context.scene.objects if obj.type == "ARMATURE"),
        },
        "topology": {},
        "issues": [],
    }

asset_path = request["assetPath"]
import_fbx(asset_path)
capability = request["capability"]
payload = request.get("input", {})

if capability == "asset.inspect":
    result = inspect()
elif capability == "material.set_base_color":
    rgba = payload["expected"]
    for obj in meshes():
        if len(obj.data.materials) == 0:
            material = bpy.data.materials.new(name="BloxBotMaterial")
            obj.data.materials.append(material)
        for material in obj.data.materials:
            material.diffuse_color = rgba
    result = {"changed": True}
elif capability == "transform.scale_uniform":
    factor = float(payload["expected"])
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale = tuple(component * factor for component in obj.scale)
    result = {"changed": True, "factor": factor}
elif capability == "asset.verify_material":
    expected = payload["expected"]
    result = {"valid": all(list(material.diffuse_color) == expected for obj in meshes() for material in obj.data.materials)}
elif capability == "asset.verify_dimensions":
    result = {"dimensions": dimensions()}
elif capability == "asset.export_fbx":
    destination = payload["destination"]
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    bpy.ops.export_scene.fbx(filepath=destination, use_selection=False)
    result = {"path": destination}
else:
    raise ValueError("Unsupported Blender capability: " + capability)

with open(response_path, "w", encoding="utf-8") as handle:
    json.dump(result, handle)
