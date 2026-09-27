"""Generate small, deterministic FBX fixtures for local Blender integration tests."""
import math
import sys

import bpy


def material(name, rgba):
    value = bpy.data.materials.new(name=name)
    value.diffuse_color = rgba
    value.use_nodes = True
    value.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
    return value


def cube(name, size, location, surface=None):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    value = bpy.context.object
    value.name = name
    if surface:
        value.data.materials.append(surface)
    return value


def parent_keep_world(child, parent):
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = world


bpy.ops.wm.read_factory_settings(use_empty=True)
args = sys.argv[1:]
fixtures = {
    "multi-root", "rotated-multi-material", "centimeter-units", "textured-material",
    "rigged", "non-manifold", "loose-geometry", "empty",
}
fixture = next((arg for arg in args[:-1] if arg in fixtures), "multi-root")
destination = args[-1]

if fixture == "multi-root":
    cube("LeftCube", 2, (0, 0, 0))
    cube("RightCube", 2, (4, 0, 0))
elif fixture == "rotated-multi-material":
    warm = material("WarmSource", (0.8, 0.1, 0.05, 1))
    cool = material("CoolSource", (0.05, 0.2, 0.8, 1))
    parent = bpy.data.objects.new("RotatedParent", None)
    bpy.context.scene.collection.objects.link(parent)
    parent.location = (3, -2, 1)
    parent.rotation_euler = (math.radians(20), math.radians(-13), math.radians(37))
    first = cube("WarmChild", 2, (1, 0, 0), warm)
    second = cube("CoolChild", 1.5, (5, 3, 2), cool)
    parent_keep_world(first, parent)
    parent_keep_world(second, parent)
    cube("IndependentRoot", 0.75, (-4, 1, 0), warm)
elif fixture == "centimeter-units":
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 0.01
    cube("CentimeterCube", 100, (0, 0, 0), material("CentimeterSource", (0.4, 0.4, 0.4, 1)))
    cube("SmallCentimeterCube", 40, (125, 20, 0), material("SmallSource", (0.2, 0.7, 0.2, 1)))
elif fixture == "textured-material":
    surface = material("ImageSource", (1, 1, 1, 1))
    image = bpy.data.images.new("GeneratedColorGrid", width=4, height=4, alpha=True)
    image.generated_type = "COLOR_GRID"
    image.filepath_raw = destination + ".png"
    image.file_format = "PNG"
    image.save()
    texture = surface.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    shader = surface.node_tree.nodes.get("Principled BSDF")
    surface.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    cube("TexturedCube", 2, (0, 0, 0), surface)
elif fixture == "rigged":
    armature_data = bpy.data.armatures.new("TestRig")
    armature = bpy.data.objects.new("TestRig", armature_data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bone = armature_data.edit_bones.new("Root")
    bone.head = (0, 0, -1)
    bone.tail = (0, 0, 1)
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh = cube("WeightedCube", 2, (0, 0, 0), material("RigSource", (0.7, 0.4, 0.1, 1)))
    parent_keep_world(mesh, armature)
    group = mesh.vertex_groups.new(name="Root")
    group.add([vertex.index for vertex in mesh.data.vertices], 1.0, "REPLACE")
    modifier = mesh.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature
elif fixture in {"non-manifold", "loose-geometry"}:
    vertices = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    edges = []
    if fixture == "non-manifold":
        faces = faces[:-1]
    else:
        vertices.extend([(3, 0, 0), (4, 0, 0)])
        edges.append((8, 9))
    mesh_data = bpy.data.meshes.new("QualityCaseMesh")
    mesh_data.from_pydata(vertices, edges, faces)
    mesh_data.update()
    obj = bpy.data.objects.new("QualityCase", mesh_data)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material("QualitySource", (0.6, 0.5, 0.4, 1)))
elif fixture == "empty":
    pass

bpy.ops.export_scene.fbx(filepath=destination, bake_anim=False)
