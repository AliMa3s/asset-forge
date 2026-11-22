"""Asset Forge harness. Runs inside Blender:

    blender --background --factory-startup --python harness.py -- spec.json

It runs one generated modelling script in an empty scene, measures the result,
saves a .blend, exports GLB (and optionally FBX), renders preview views and
writes result.json. It always writes result.json, also when the script fails.
"""

import ast
import contextlib
import io
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

ALLOWED_IMPORTS = {
    "bpy", "bmesh", "mathutils", "math", "random", "colorsys", "itertools",
    "functools", "collections", "numpy", "typing", "dataclasses", "enum",
}
FORBIDDEN_CALLS = {"eval", "exec", "compile", "open", "__import__", "input", "breakpoint"}
FORBIDDEN_PREFIXES = (
    "bpy.ops.wm", "bpy.ops.script", "bpy.ops.preferences", "bpy.ops.file",
    "bpy.ops.export_scene", "bpy.ops.import_scene", "bpy.ops.render",
    "bpy.ops.image.save", "bpy.app.handlers", "bpy.utils", "bpy.data.libraries",
)
GEOMETRY_TYPES = {"MESH", "CURVE", "SURFACE", "FONT", "META"}


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def validate(code):
    """Reject scripts that reach outside modelling. Returns a list of problems."""
    problems = []
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS:
                    problems.append("import of '%s' is not allowed" % alias.name)
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                problems.append("import from '%s' is not allowed" % node.module)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_CALLS:
                problems.append("call to '%s' is not allowed" % node.func.id)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") and node.attr.endswith("__"):
                problems.append("access to '%s' is not allowed" % node.attr)
            name = dotted(node)
            for prefix in FORBIDDEN_PREFIXES:
                if name == prefix or name.startswith(prefix + "."):
                    problems.append("'%s' is not allowed (the harness saves, exports and renders)" % name)
    return sorted(set(problems))


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name.split(".")[0] not in ALLOWED_IMPORTS:
        raise ImportError("import of '%s' is not allowed in asset scripts" % name)
    return __import__(name, globals, locals, fromlist, level)


def run_script(code):
    builtins_dict = dict(__builtins__) if isinstance(__builtins__, dict) else dict(vars(__builtins__))
    for name in FORBIDDEN_CALLS:
        builtins_dict.pop(name, None)
    builtins_dict["__import__"] = guarded_import
    namespace = {"__name__": "__main__", "__builtins__": builtins_dict}
    exec(compile(code, "asset_script.py", "exec"), namespace)


def world_bounds(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((math.inf, math.inf, math.inf))
    hi = Vector((-math.inf, -math.inf, -math.inf))
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            point = evaluated.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], point[i])
                hi[i] = max(hi[i], point[i])
    return lo, hi


def collect_stats(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts = faces = 0
    without_material = []
    per_object = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        v = f = 0
        try:
            mesh = evaluated.to_mesh()
            v, f = len(mesh.vertices), len(mesh.polygons)
            evaluated.to_mesh_clear()
        except Exception:
            pass
        verts += v
        faces += f
        if not [slot for slot in obj.material_slots if slot.material]:
            without_material.append(obj.name)
        lo, hi = world_bounds([obj])
        per_object.append({
            "name": obj.name, "type": obj.type, "faces": f,
            "min": [round(x, 3) for x in lo], "max": [round(x, 3) for x in hi],
        })
    lo, hi = world_bounds(objects)
    materials = sorted({slot.material.name for o in objects for slot in o.material_slots if slot.material})
    return {
        "objects": len(objects), "vertices": verts, "faces": faces,
        "bounds_min": [round(x, 3) for x in lo], "bounds_max": [round(x, 3) for x in hi],
        "size": [round(hi[i] - lo[i], 3) for i in range(3)],
        "materials": materials, "without_material": without_material,
        "per_object": per_object[:60],
    }, lo, hi


def quality_warnings(stats):
    warnings = []
    size = stats["size"]
    biggest = max(size)
    if stats["bounds_min"][2] < -0.02 * max(biggest, 0.01):
        warnings.append("Part of the model is below the ground (z < 0): lowest point is z=%.3f." % stats["bounds_min"][2])
    if stats["bounds_min"][2] > 0.02 * max(biggest, 0.01):
        warnings.append("The model floats above the ground: lowest point is z=%.3f." % stats["bounds_min"][2])
    if stats["without_material"]:
        warnings.append("Objects without a material: %s." % ", ".join(stats["without_material"][:8]))
    if stats["faces"] > 400000:
        warnings.append("Very high polygon count (%d faces)." % stats["faces"])
    if biggest < 0.005:
        warnings.append("The model is tiny (largest dimension %.4f m)." % biggest)
    if biggest > 500:
        warnings.append("The model is huge (largest dimension %.1f m)." % biggest)
    center_x = (stats["bounds_min"][0] + stats["bounds_max"][0]) / 2
    center_y = (stats["bounds_min"][1] + stats["bounds_max"][1]) / 2
    if abs(center_x) > 0.25 * biggest or abs(center_y) > 0.25 * biggest:
        warnings.append("The model is not centred on the origin in X/Y (centre is %.2f, %.2f)." % (center_x, center_y))
    return warnings


def export_files(out_dir, want_fbx):
    files, problems = {}, []
    blend_path = os.path.join(out_dir, "asset.blend")
    try:
        bpy.ops.wm.save_as_mainfile(filepath=blend_path, check_existing=False)
        files["blend"] = "asset.blend"
    except Exception as exc:
        problems.append("Saving .blend failed: %s" % exc)
    glb_path = os.path.join(out_dir, "asset.glb")
    try:
        try:
            bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", export_apply=True)
        except TypeError:
            bpy.ops.export_scene.gltf(filepath=glb_path)
        if os.path.exists(glb_path):
            files["glb"] = "asset.glb"
    except Exception as exc:
        problems.append("GLB export failed: %s" % exc)
    if want_fbx:
        fbx_path = os.path.join(out_dir, "asset.fbx")
        try:
            bpy.ops.export_scene.fbx(filepath=fbx_path)
            if os.path.exists(fbx_path):
                files["fbx"] = "asset.fbx"
        except Exception as exc:
            problems.append("FBX export failed: %s" % exc)
    return files, problems


def make_material(name, color):
    material = bpy.data.materials.new(name)
    try:
        material.use_nodes = True
    except Exception:
        pass
    material.diffuse_color = color
    tree = getattr(material, "node_tree", None)
    if tree:
        for node in tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                node.inputs["Base Color"].default_value = color
                node.inputs["Roughness"].default_value = 0.9
    return material


def setup_rig(lo, hi):
    scene = bpy.context.scene
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)

    plane_size = radius * 40
    bpy.ops.mesh.primitive_plane_add(size=plane_size, location=(center.x, center.y, lo.z - radius * 0.002))
    ground = bpy.context.active_object
    ground.name = "_forge_ground"
    ground.data.materials.append(make_material("_forge_ground", (0.36, 0.38, 0.41, 1.0)))

    sun_data = bpy.data.lights.new("_forge_sun", "SUN")
    sun_data.energy = 2.0
    sun = bpy.data.objects.new("_forge_sun", sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)

    fill_data = bpy.data.lights.new("_forge_fill", "SUN")
    fill_data.energy = 0.5
    fill = bpy.data.objects.new("_forge_fill", fill_data)
    fill.rotation_euler = (math.radians(60), 0, math.radians(215))
    scene.collection.objects.link(fill)

    world = bpy.data.worlds.new("_forge_world")
    try:
        world.use_nodes = True
    except Exception:
        pass
    tree = getattr(world, "node_tree", None)
    background = tree.nodes.get("Background") if tree else None
    if background:
        background.inputs[0].default_value = (0.82, 0.86, 0.92, 1.0)
        background.inputs[1].default_value = 0.45
    scene.world = world

    camera_data = bpy.data.cameras.new("_forge_camera")
    camera_data.lens = 50
    camera_data.clip_start = max(radius * 0.01, 0.001)
    camera_data.clip_end = radius * 200
    camera = bpy.data.objects.new("_forge_camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera, center, radius


VIEWS = [
    ("front_right", 35, 24),
    ("back_left", 215, 24),
    ("side", 90, 8),
    ("top", 20, 68),
]


def render_views(out_dir, lo, hi, size):
    scene = bpy.context.scene
    camera, center, radius = setup_rig(lo, hi)
    fov = 2 * math.atan(18.0 / camera.data.lens)
    distance = radius / math.sin(fov / 2) * 1.12

    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    try:
        scene.view_settings.view_transform = "Standard"
    except Exception:
        pass

    engines = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"]
    renders, used, errors = [], None, []
    for engine in engines:
        try:
            scene.render.engine = engine
        except Exception:
            continue
        if engine == "CYCLES":
            try:
                scene.cycles.samples = 24
                scene.cycles.use_denoising = False
            except Exception:
                pass
        elif engine.startswith("BLENDER_EEVEE"):
            try:
                scene.eevee.taa_render_samples = 16
            except Exception:
                pass
        renders = []
        try:
            for name, azimuth, elevation in VIEWS:
                az, el = math.radians(azimuth), math.radians(elevation)
                direction = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
                camera.location = center + direction * distance
                camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
                path = os.path.join(out_dir, "view_%s.png" % name)
                scene.render.filepath = path
                bpy.ops.render.render(write_still=True)
                if not os.path.exists(path) or os.path.getsize(path) < 500:
                    raise RuntimeError("render produced no image")
                renders.append("view_%s.png" % name)
            used = engine
            break
        except Exception as exc:
            errors.append("%s: %s" % (engine, exc))
    return renders, used, errors


def main():
    spec_path = sys.argv[sys.argv.index("--") + 1]
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    out_dir = spec["out_dir"]
    result = {
        "ok": False, "stage": "start", "error": None, "traceback": None, "stdout": "",
        "stats": None, "warnings": [], "renders": [], "files": {}, "engine": None,
        "blender_version": bpy.app.version_string,
    }
    try:
        with open(spec["code_path"], "r", encoding="utf-8") as handle:
            code = handle.read()

        result["stage"] = "validate"
        try:
            problems = validate(code)
        except SyntaxError as exc:
            result["error"] = "SyntaxError: %s (line %s)" % (exc.msg, exc.lineno)
            return result
        if problems:
            result["error"] = "Script rejected by the safety check: " + "; ".join(problems)
            return result

        result["stage"] = "run"
        bpy.ops.wm.read_factory_settings(use_empty=True)
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                run_script(code)
        except Exception as exc:
            tb = traceback.format_exc()
            lines = [line for line in tb.splitlines()]
            result["error"] = "%s: %s" % (type(exc).__name__, exc)
            result["traceback"] = "\n".join(lines[-25:])
            result["stdout"] = captured.getvalue()[-2000:]
            return result
        result["stdout"] = captured.getvalue()[-2000:]

        result["stage"] = "measure"
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        removed = []
        for obj in list(bpy.context.scene.objects):
            if obj.type in {"CAMERA", "LIGHT"}:
                removed.append(obj.name)
                bpy.data.objects.remove(obj, do_unlink=True)
        if removed:
            result["warnings"].append("Removed cameras/lights the script created: %s." % ", ".join(removed[:6]))
        bpy.context.view_layer.update()
        objects = [o for o in bpy.context.scene.objects if o.type in GEOMETRY_TYPES and not o.hide_render]
        if not objects:
            result["error"] = "The script ran but created no visible geometry in the scene."
            return result
        stats, lo, hi = collect_stats(objects)
        if stats["faces"] == 0:
            result["error"] = "The script created objects but they contain no faces."
            return result
        result["stats"] = stats
        result["warnings"] += quality_warnings(stats)

        result["stage"] = "export"
        files, problems = export_files(out_dir, bool(spec.get("export_fbx")))
        result["files"] = files
        result["warnings"] += problems

        result["stage"] = "render"
        renders, engine, errors = render_views(out_dir, lo, hi, int(spec.get("render_size", 640)))
        result["renders"] = renders
        result["engine"] = engine
        if not renders:
            result["error"] = "Rendering failed with every engine: " + " | ".join(errors)
            return result
        result["ok"] = True
        result["stage"] = "done"
        return result
    except Exception as exc:
        result["error"] = "Harness failure at stage '%s': %s" % (result["stage"], exc)
        result["traceback"] = traceback.format_exc()[-3000:]
        return result
    finally:
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=1)


main()
