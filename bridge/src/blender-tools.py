"""Built-in Blender inspection/render commands; no external scripts auto-run."""
import argparse
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("inspect", "render", "smoke"))
    parser.add_argument("--input")
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--resolution", type=int, default=512)
    parser.add_argument("--frame", type=int, default=1)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.input:
        src = Path(args.input)
        extension = src.suffix.lower()
        if extension == ".blend": bpy.ops.wm.open_mainfile(filepath=str(src), load_ui=False, use_scripts=False)
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            if extension in (".glb", ".gltf"): bpy.ops.import_scene.gltf(filepath=str(src))
            elif extension == ".fbx": bpy.ops.import_scene.fbx(filepath=str(src))
            elif extension == ".obj": bpy.ops.wm.obj_import(filepath=str(src))
            elif extension == ".stl": bpy.ops.wm.stl_import(filepath=str(src))
            else: raise ValueError("Unsupported asset extension: " + extension)
    elif args.action == "smoke":
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.mesh.primitive_cube_add()
        bpy.context.object.name = "ShiroToolchainSmokeCube"
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.output).with_suffix(".blend")))
        bpy.ops.export_scene.gltf(filepath=str(Path(args.output).with_suffix(".glb")), export_format="GLB")
    else: raise ValueError("An input asset is required")
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    triangles = vertices = 0
    bounds = []
    for obj in meshes:
        obj.data.calc_loop_triangles()
        vertices += len(obj.data.vertices)
        triangles += len(obj.data.loop_triangles)
        bounds.extend(obj.matrix_world @ Vector(v) for v in obj.bound_box)
    report = {"blender_version": bpy.app.version_string, "mesh_objects": len(meshes),
              "vertices": vertices, "triangles": triangles,
              "materials": len(bpy.data.materials), "armatures": len(bpy.data.armatures),
              "actions": len(bpy.data.actions),
              "missing_images": [i.name for i in bpy.data.images if i.source == "FILE" and not i.packed_file and not Path(bpy.path.abspath(i.filepath)).is_file()],
              "finite_bounds": all(math.isfinite(c) for v in bounds for c in v),
              "rendered": False}
    if args.action in ("render", "smoke"):
        if not bounds: raise ValueError("No mesh geometry to render")
        low = Vector(tuple(min(v[i] for v in bounds) for i in range(3)))
        high = Vector(tuple(max(v[i] for v in bounds) for i in range(3)))
        center = (low + high) / 2
        radius = max((high - low).length / 2, .25)
        scene = bpy.context.scene
        # CPU Cycles works without changing the host GPU driver or a display session.
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 12
        scene.render.threads_mode = "FIXED"
        scene.render.threads = 4
        if not scene.world: scene.world = bpy.data.worlds.new("ShiroPreviewWorld")
        scene.world.use_nodes = True
        scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.15, .15, .15, 1)
        scene.world.node_tree.nodes["Background"].inputs[1].default_value = .8
        camera_data = bpy.data.cameras.new("ShiroPreviewCamera")
        camera = bpy.data.objects.new("ShiroPreviewCamera", camera_data)
        scene.collection.objects.link(camera)
        camera.location = center + Vector((1.5, -2, 1.4)).normalized() * radius * 4.2
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera_data.lens = 45
        camera_data.clip_end = max(1000, radius * 20)
        scene.camera = camera
        light_data = bpy.data.lights.new("ShiroPreviewKey", "AREA")
        light_data.energy = 600 * radius * radius
        light_data.shape = "DISK"
        light_data.size = radius * 3
        light = bpy.data.objects.new("ShiroPreviewKey", light_data)
        scene.collection.objects.link(light)
        light.location = center + Vector((2, -2, 4)) * radius
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.resolution_x = scene.render.resolution_y = max(64, min(args.resolution, 2048))
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = str(Path(args.output))
        scene.frame_set(args.frame)
        bpy.ops.render.render(write_still=True)
        report["rendered"] = Path(args.output).is_file()
        report["output"] = args.output
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))

if __name__ == "__main__": main()
