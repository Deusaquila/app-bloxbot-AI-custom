"""Generate a disposable deterministic multi-root FBX for integration tests."""
import bpy
import sys
bpy.ops.wm.read_factory_settings(use_empty=True)
for x in (0, 4):
    bpy.ops.mesh.primitive_cube_add(location=(x, 0, 0))
bpy.ops.export_scene.fbx(filepath=sys.argv[-1], bake_anim=False)
