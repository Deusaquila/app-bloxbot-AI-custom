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
fixtures = {"multi-root", "rotated-multi-material", "centimeter-units", "empty"}
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
elif fixture == "empty":
    pass

bpy.ops.export_scene.fbx(filepath=destination, bake_anim=False)
