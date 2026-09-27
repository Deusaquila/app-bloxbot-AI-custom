"""Deterministic V1 adapter. Every mutation writes a new scene; input is immutable."""
import bpy
import bmesh
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


def vector_dict(value):
    return {axis: float(getattr(value, axis)) for axis in ("x", "y", "z")}


def object_dimensions(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    if not points:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    return {axis: max(getattr(p, axis) for p in points) - min(getattr(p, axis) for p in points)
            for axis in ("x", "y", "z")}


def connected_components(data):
    remaining = set(data.verts)
    components = 0
    while remaining:
        components += 1
        start = remaining.pop()
        pending = [start]
        while pending:
            vertex = pending.pop()
            for edge in vertex.link_edges:
                neighbour = edge.other_vert(vertex)
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    pending.append(neighbour)
    return components


def mesh_fingerprint(obj):
    obj.data.calc_loop_triangles()
    data = bmesh.new()
    data.from_mesh(obj.data)
    try:
        edges = list(data.edges)
        manifold_edges = sum(1 for edge in edges if edge.is_manifold)
        boundary_edges = sum(1 for edge in edges if edge.is_boundary)
        wire_edges = sum(1 for edge in edges if edge.is_wire)
        non_manifold_edges = sum(
            1 for edge in edges
            if not edge.is_manifold and not edge.is_boundary and not edge.is_wire
        )
        loose_vertices = sum(1 for vertex in data.verts if not vertex.link_edges)
        loose_edges = sum(1 for edge in edges if not edge.link_faces)
        # Scale the area tolerance to the mesh so unit changes do not alter the result.
        dimensions_value = object_dimensions(obj)
        diagonal_squared = sum(value * value for value in dimensions_value.values())
        area_tolerance = max(diagonal_squared * 1e-12, 1e-16)
        degenerate_faces = sum(1 for face in data.faces if face.calc_area() <= area_tolerance)
        components = connected_components(data)
    finally:
        data.free()

    face_counts = {}
    for polygon in obj.data.polygons:
        face_counts[polygon.material_index] = face_counts.get(polygon.material_index, 0) + 1
    slots = []
    for index, material in enumerate(obj.data.materials):
        slot = {
            "objectId": obj.name,
            "index": index,
            "assignedFaces": face_counts.get(index, 0),
        }
        if material is not None:
            slot["materialName"] = material.name
        slots.append(slot)
    unmapped_faces = sum(count for index, count in face_counts.items()
                         if index < 0 or index >= len(obj.data.materials))
    return {
        "objectId": obj.name,
        "vertices": len(obj.data.vertices),
        "edges": len(obj.data.edges),
        "faces": len(obj.data.polygons),
        "triangles": len(obj.data.loop_triangles),
        "unmappedFaces": unmapped_faces,
        "dimensions": dimensions_value,
        "materialSlots": slots,
    }, {
        "edges": len(edges),
        "manifoldEdges": manifold_edges,
        "boundaryEdges": boundary_edges,
        "nonManifoldEdges": non_manifold_edges,
        "wireEdges": wire_edges,
        "looseVertices": loose_vertices,
        "looseEdges": loose_edges,
        "degenerateFaces": degenerate_faces,
        "components": components,
    }


def material_fingerprint(material):
    texture_images = sorted({
        node.image.name
        for node in material.node_tree.nodes
        if material.use_nodes and node.type == "TEX_IMAGE" and node.image is not None
    }) if material.use_nodes and material.node_tree else []
    texture_limit = 16
    result = {
        "name": material.name,
        "hasTextures": bool(texture_images),
        "textureImages": texture_images[:texture_limit],
        "omittedTextureImages": max(0, len(texture_images) - texture_limit),
    }
    rgba = color(material)
    if rgba is not None:
        result["baseColor"] = rgba
    if material.use_nodes and material.node_tree:
        shaders = [node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]
        if len(shaders) == 1 and not shaders[0].inputs["Alpha"].is_linked:
            result["alpha"] = float(shaders[0].inputs["Alpha"].default_value)
    else:
        result["alpha"] = float(material.diffuse_color[3])
    return result


def object_depth(obj):
    depth = 0
    parent = obj.parent
    while parent is not None and depth <= len(bpy.context.scene.objects):
        depth += 1
        parent = parent.parent
    return depth


def structure_fingerprint():
    objects = list(bpy.context.scene.objects)
    object_types = {}
    for obj in objects:
        object_types[obj.type] = object_types.get(obj.type, 0) + 1
    ordered = sorted(objects, key=lambda obj: (obj.name, obj.type))
    node_limit = 256
    selected = ordered[:node_limit]
    nodes = []
    for obj in selected:
        node = {
            "id": obj.name,
            "type": obj.type,
            "depth": object_depth(obj),
            "location": vector_dict(obj.location),
            "rotation": vector_dict(obj.rotation_euler),
            "scale": vector_dict(obj.scale),
            "hiddenViewport": bool(obj.hide_viewport),
            "hiddenRender": bool(obj.hide_render),
        }
        if obj.parent is not None:
            node["parentId"] = obj.parent.name
        nodes.append(node)
    return {
        "rootObjects": sum(1 for obj in objects if obj.parent is None),
        "parentedObjects": sum(1 for obj in objects if obj.parent is not None),
        "emptyObjects": sum(1 for obj in objects if obj.type == "EMPTY"),
        "maximumDepth": max((object_depth(obj) for obj in objects), default=0),
        "omittedObjects": max(0, len(objects) - len(nodes)),
        "objectTypes": [
            {"type": name, "count": count} for name, count in sorted(object_types.items())
        ],
        "objectNodes": nodes,
    }


def rig_fingerprint(objects):
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    bone_names = {obj: {bone.name for bone in obj.data.bones} for obj in armatures}
    weighted_vertices = 0
    unweighted_vertices = 0
    skinned_meshes = 0
    for mesh in objects:
        linked_armatures = {
            modifier.object for modifier in mesh.modifiers
            if modifier.type == "ARMATURE" and modifier.object is not None
            and modifier.object.type == "ARMATURE"
        }
        if mesh.parent is not None and mesh.parent.type == "ARMATURE":
            linked_armatures.add(mesh.parent)
        if not linked_armatures:
            continue
        skinned_meshes += 1
        deform_groups = {
            group.index for group in mesh.vertex_groups
            if any(group.name in bone_names.get(armature, set()) for armature in linked_armatures)
        }
        for vertex in mesh.data.vertices:
            has_weight = any(
                assignment.group in deform_groups and assignment.weight > 0
                for assignment in vertex.groups
            )
            if has_weight:
                weighted_vertices += 1
            else:
                unweighted_vertices += 1

    actions = set()
    for obj in bpy.context.scene.objects:
        animation = obj.animation_data
        if animation is None:
            continue
        if animation.action is not None:
            actions.add(animation.action.name)
        for track in animation.nla_tracks:
            for strip in track.strips:
                if strip.action is not None:
                    actions.add(strip.action.name)
    return {
        "exists": bool(armatures),
        "bones": sum(len(obj.data.bones) for obj in armatures),
        "armatureIds": sorted(obj.name for obj in armatures),
        "deformBones": sum(1 for obj in armatures for bone in obj.data.bones if bone.use_deform),
        "skinnedMeshes": skinned_meshes,
        "weightedVertices": weighted_vertices,
        "unweightedVertices": unweighted_vertices,
        "animationClips": sorted(actions),
    }


def inspect():
    bpy.context.view_layer.update()
    objects = meshes()
    materials = {m.name: m for obj in objects for m in obj.data.materials if m is not None}
    mesh_details = []
    totals = {
        "edges": 0, "manifoldEdges": 0, "boundaryEdges": 0,
        "nonManifoldEdges": 0, "wireEdges": 0, "looseVertices": 0,
        "looseEdges": 0, "degenerateFaces": 0,
    }
    mesh_limit = 256
    disconnected_components = 0
    for obj in sorted(objects, key=lambda value: value.name):
        detail, quality = mesh_fingerprint(obj)
        if len(mesh_details) < mesh_limit:
            mesh_details.append(detail)
        disconnected_components += max(0, quality["components"] - 1)
        for key in totals:
            totals[key] += quality[key]
    omitted_meshes = max(0, len(objects) - len(mesh_details))
    edge_count = totals["edges"]
    mesh_topology = {
        "manifoldRatio": totals["manifoldEdges"] / edge_count if edge_count else 1.0,
        "looseGeometry": bool(totals["looseVertices"] or totals["looseEdges"]),
        "edges": totals["edges"],
        "manifoldEdges": totals["manifoldEdges"],
        "boundaryEdges": totals["boundaryEdges"],
        "nonManifoldEdges": totals["nonManifoldEdges"],
        "wireEdges": totals["wireEdges"],
        "looseVertices": totals["looseVertices"],
        "degenerateFaces": totals["degenerateFaces"],
    }
    issues = []
    if mesh_topology["manifoldRatio"] < 1.0:
        issues.append({"code": "NON_MANIFOLD_EDGES", "severity": "WARNING",
                       "message": "Some mesh edges do not have exactly two adjacent faces"})
    if mesh_topology["looseGeometry"]:
        issues.append({"code": "LOOSE_GEOMETRY", "severity": "WARNING",
                       "message": "Mesh contains loose vertices or edges"})
    return {
        "assetId": request["assetId"], "format": "fbx",
        "objects": len(bpy.context.scene.objects), "meshes": len(objects),
        "vertices": sum(len(obj.data.vertices) for obj in objects),
        "triangles": sum(len(obj.data.loop_triangles) for obj in objects),
        "materials": [material_fingerprint(m) for m in sorted(materials.values(), key=lambda value: value.name)],
        "dimensions": dimensions(),
        "transforms": {"scale": [1, 1, 1], "rotation": [0, 0, 0]},
        "rig": rig_fingerprint(objects),
        "topology": mesh_topology,
        "geometry": {
            "disconnectedComponents": disconnected_components,
            "meshes": mesh_details,
            "omittedMeshes": omitted_meshes,
        },
        "structure": structure_fingerprint(),
        "issues": issues,
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
        # Persist the absolute target so a retry never turns 2x into 4x.
        previous = bpy.context.scene.get("bloxbot_v1_scale_factor", 1.0)
        if not isinstance(previous, (float, int)) or not math.isfinite(previous) or previous <= 0:
            raise ValueError("Invalid persisted scale factor")
        transform = Matrix.Scale(factor / previous, 4)
        for obj in bpy.context.scene.objects:
            if obj.parent is None:
                obj.matrix_world = transform @ obj.matrix_world
        bpy.context.scene["bloxbot_v1_scale_factor"] = factor
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
                                 add_leaf_bones=False, bake_anim=False, apply_scale_options='FBX_SCALE_UNITS', axis_forward='-Z', axis_up='Y')
        if not os.path.isfile(destination) or os.path.getsize(destination) == 0:
            raise ValueError("FBX export produced no data")
        return {"path": destination, "fingerprint": inspect(), "bytes": os.path.getsize(destination), "blenderVersion": bpy.app.version_string}
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
