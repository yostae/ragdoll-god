"""Build creature GLBs from creatures/specs/*.json with Blender (headless).

Usage:
    blender -b -P tools/build_creatures.py -- [ids or spec paths...] [--preview] [--no-export]

Every spec part becomes one bone (named exactly part.name) plus one chunk of low-poly mesh
rigidly skinned (weight 1.0) to that bone. All geometry is authored in the spec's Y-up glTF
frame and converted to Blender's Z-up frame with (bx, by, bz) = (x, -z, y), so exporting with
export_yup=True round-trips positions exactly.

Bone convention: every bone's head sits at the part's collider center (spec `pos`), the bone
points along Blender +Z (= glTF +Y) with roll 0, which after the exporter's Y-up basis change
gives every bone an identity world rest rotation in the GLB. Bone world rest translation ==
spec part `pos`. Parts with a `rot` (e.g. the wolf tail) still get an identity bone rotation;
only the mesh is rotated.
"""

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC_DIR = os.path.join(ROOT, "creatures", "specs")
OUT_DIR = os.path.join(ROOT, "public", "models")
PREVIEW_DIR = os.path.join(OUT_DIR, "preview")

# spec (x, y, z) [Y-up, faces +X] -> blender (x, -z, y) [Z-up]
SPEC_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
# bmesh cones/spheres have their axis along Z; rotate so the axis is local +Y (spec capsules)
Z_TO_Y = Matrix.Rotation(math.radians(-90.0), 4, "X")

BUILTIN_COLORS = {"eye": "#141414", "eyeWhite": "#f8f8f8"}


# ----------------------------------------------------------------------------- helpers

def hex_to_linear(hex_str):
    h = hex_str.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def to_lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(to_lin(c) for c in srgb) + (1.0,)


def rot_matrix(rot):
    """Euler XYZ degrees (spec convention) -> 4x4 matrix. None -> identity."""
    if rot is None:
        return Matrix.Identity(4)
    if isinstance(rot, Matrix):
        return rot.to_4x4()
    return Euler([math.radians(a) for a in rot], "XYZ").to_matrix().to_4x4()


def dir_rot(d):
    """Rotation that maps local +Y onto direction d (spec frame)."""
    return Vector((0, 1, 0)).rotation_difference(Vector(d).normalized()).to_matrix().to_4x4()


def trs(center, rot=None, scale=(1, 1, 1)):
    m = Matrix.Translation(Vector(center)) @ rot_matrix(rot)
    if scale != (1, 1, 1):
        m = m @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    return m


def part_axis(part):
    """World direction of a capsule part's local +Y axis (spec frame)."""
    return (rot_matrix(part.get("rot")) @ Vector((0, 1, 0, 0))).xyz


def capsule_ends(part):
    c = Vector(part["pos"])
    ax = part_axis(part)
    half = part["size"][1] / 2.0
    return c + ax * half, c - ax * half


def v(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


class MeshBuilder:
    """Accumulates low-poly primitives (authored in the spec frame) into one mesh.

    Every vertex is tagged with the index of the part it belongs to (rigid skinning), every
    face with a material index. Coordinates are converted to Blender's Z-up frame on insert.
    """

    def __init__(self, materials):
        self.materials = materials  # name -> index
        self.verts = []
        self.faces = []
        self.face_mats = []
        self.vert_part = []
        self.part_index = -1

    def begin_part(self, index):
        self.part_index = index

    def mat(self, name):
        if name not in self.materials:
            print(f"  [warn] unknown material '{name}', using magenta placeholder")
            self.materials[name] = len(self.materials)
        return self.materials[name]

    def _add(self, bm, mat_name, matrix):
        base = len(self.verts)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        full = SPEC_TO_BLENDER @ matrix
        mi = self.mat(mat_name)
        for vert in bm.verts:
            self.verts.append(tuple(full @ vert.co))
            self.vert_part.append(self.part_index)
        for face in bm.faces:
            self.faces.append([base + vv.index for vv in face.verts])
            self.face_mats.append(mi)
        bm.free()

    # --- primitives (all centered at `c`, spec frame, rot = Euler XYZ degrees or Matrix)

    def box(self, c, size, mat, rot=None):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        self._add(bm, mat, trs(c, rot, tuple(size)))

    def sphere(self, c, r, mat, rot=None, scale=(1, 1, 1), segs=8, rings=5):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
        self._add(bm, mat, trs(c, rot, scale) @ Z_TO_Y)

    def capsule(self, c, r, length, mat, rot=None, segs=8):
        """Capsule with axis along local +Y (spec capsule convention)."""
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=5, radius=r)
        half = length / 2.0
        for vert in bm.verts:
            if vert.co.z > 1e-6:
                vert.co.z += half
            elif vert.co.z < -1e-6:
                vert.co.z -= half
        self._add(bm, mat, trs(c, rot) @ Z_TO_Y)

    def cone(self, c, r1, r2, depth, mat, rot=None, segs=6):
        """Truncated cone with axis along local +Y, base (r1) at -Y, tip (r2) at +Y."""
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              radius1=r1, radius2=r2, depth=depth)
        self._add(bm, mat, trs(c, rot) @ Z_TO_Y)

    def spike(self, base, direction, length, r, mat, segs=5):
        """Cone whose base is at `base` and whose tip is `length` along `direction`."""
        d = Vector(direction).normalized()
        center = Vector(base) + d * (length / 2.0)
        self.cone(center, r, 0.004, length, mat, rot=dir_rot(d), segs=segs)

    def collider(self, part, mat, inflate=0.0):
        shape, c, s = part["shape"], part["pos"], part["size"]
        rot = part.get("rot")
        if shape == "box":
            self.box(c, [s[0] + 2 * inflate, s[1] + 2 * inflate, s[2] + 2 * inflate], mat, rot)
        elif shape == "capsule":
            self.capsule(c, s[0] + inflate, s[1], mat, rot)
        elif shape == "sphere":
            self.sphere(c, s[0] + inflate, mat, rot)
        else:
            raise ValueError(f"unknown shape {shape}")

    def eyes(self, center, forward_offset, up_offset, z_half, r, white=True, pupil_r=None):
        """Pair of eyes on the +Z/-Z sides of a head so they read from the side camera."""
        pupil_r = pupil_r or r * 0.55
        for sgn in (-1, 1):
            p = (center[0] + forward_offset, center[1] + up_offset, center[2] + sgn * z_half)
            if white:
                self.sphere(p, r, "eyeWhite", segs=6, rings=4)
                self.sphere((p[0] + r * 0.25, p[1], p[2] + sgn * r * 0.55), pupil_r, "eye", segs=6, rings=4)
            else:
                self.sphere(p, r, "eye", segs=6, rings=4)


# ----------------------------------------------------------------------------- creature looks

def look_default(b, part, spec):
    role = part.get("role", "")
    pal = spec["palette"]
    first = next(iter(pal))
    b.collider(part, first)
    if role == "head":
        c, s = part["pos"], part["size"]
        d = s[2] / 2 if part["shape"] == "box" else s[0]
        b.eyes(c, d * 0.5, d * 0.2, d, d * 0.15)


def look_knight(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "armorDark")
        b.box(v(c, (0, 0.075, 0)), (s[0] + 0.02, 0.05, s[2] + 0.02), "boots")  # belt
    elif name == "torso":
        b.collider(part, "armor")
        b.box(v(c, (s[0] / 2, -0.02, 0)), (0.03, 0.3, 0.14), "cloth")  # tabard on the chest
        b.box(v(c, (-s[0] / 2, 0.0, 0)), (0.03, 0.3, 0.14), "cloth")  # and on the back
    elif name == "head":
        b.collider(part, "armor")
        b.box(v(c, (s[0] / 2, 0.02, 0)), (0.02, 0.035, 0.18), "eye")  # visor slit, front
        for sgn in (-1, 1):  # slit wraps around the sides so it reads from the side camera
            b.box(v(c, (0.04, 0.02, sgn * s[2] / 2)), (0.18, 0.035, 0.02), "eye")
            b.sphere(v(c, (s[0] / 2 + 0.008, 0.02, sgn * 0.05)), 0.011, "eyeWhite", segs=6, rings=4)
            b.sphere(v(c, (0.06, 0.02, sgn * (s[2] / 2 + 0.006))), 0.011, "eyeWhite", segs=6, rings=4)
        b.box(v(c, (s[0] / 2, -0.07, 0)), (0.02, 0.06, 0.16), "armorDark")  # chin guard
        b.box(v(c, (-0.02, s[1] / 2, 0)), (0.2, 0.03, 0.04), "armorDark")  # crest ridge
        base = v(c, (-0.05, s[1] / 2 + 0.01, 0))
        d = Vector((-math.sin(math.radians(35)), math.cos(math.radians(35)), 0))
        center = Vector(base) + d * 0.11
        b.capsule(center, 0.04, 0.14, "plume", rot=[0, 0, 35])
    elif name.startswith("upperArm"):
        b.collider(part, "armor")
        top, _ = capsule_ends(part)
        b.sphere(top, 0.08, "armor", scale=(1, 0.8, 1))  # pauldron
    elif name.startswith("lowerArm"):
        b.collider(part, "armor")
    elif name.startswith("hand"):
        b.collider(part, "skin")
    elif name.startswith("upperLeg"):
        b.collider(part, "cloth")
    elif name.startswith("lowerLeg"):
        b.collider(part, "armor")
    elif name.startswith("foot"):
        b.collider(part, "boots")
        b.sphere(v(c, (s[0] / 2 - 0.03, 0, 0)), 0.045, "boots", scale=(1, 0.9, 1.4))  # toe
    else:
        look_default(b, part, spec)


def look_goblin(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.box(c, (s[0] + 0.02, s[1], s[2] + 0.02), "clothDark")  # loincloth
        for x in (s[0] / 2 + 0.01, -s[0] / 2 - 0.01):
            for z in (-0.04, 0.04):
                b.spike(v(c, (x, -s[1] / 2, z)), (0, -1, 0), 0.06, 0.025, "clothDark")
    elif name == "torso":
        b.collider(part, "skin")
        b.box(v(c, (0, 0.02, 0)), (s[0] + 0.04, s[1] - 0.04, s[2] + 0.03), "cloth")  # ragged tunic
        hem = -s[1] / 2 + 0.03
        for (x, z) in ((s[0] / 2 + 0.02, 0.0), (-s[0] / 2 - 0.02, 0.0), (0.0, s[2] / 2 + 0.015),
                       (0.0, -s[2] / 2 - 0.015), (0.09, s[2] / 2 + 0.015), (-0.09, -s[2] / 2 - 0.015)):
            b.spike(v(c, (x, hem, z)), (0, -1, 0), 0.07, 0.03, "cloth")
    elif name == "head":
        b.sphere(c, s[0] / 2, "skin", scale=(1.0, s[1] / s[0], s[2] / s[0]))
        b.sphere(v(c, (0.02, -0.08, 0)), 0.11, "skin", scale=(1.1, 0.6, 1.1))  # jaw / chin
        # big nose
        b.cone(v(c, (s[0] / 2 + 0.03, 0.0, 0)), 0.035, 0.012, 0.1, "skinDark", rot=[0, 0, -90])
        # mouth
        b.box(v(c, (s[0] / 2 - 0.01, -0.06, 0)), (0.02, 0.015, 0.14), "eye")
        for z in (-0.04, 0.04):
            b.spike(v(c, (s[0] / 2 - 0.005, -0.055, z)), (0, 1, 0), 0.03, 0.01, "teeth")
        # eyes
        for sgn in (-1, 1):
            p = v(c, (0.07, 0.04, sgn * 0.13))
            b.sphere(p, 0.04, "eyeYellow", segs=6, rings=4)
            b.sphere((p[0] + 0.012, p[1], p[2] + sgn * 0.025), 0.02, "eye", segs=6, rings=4)
        # long pointy ears
        for sgn in (-1, 1):
            b.spike(v(c, (-0.05, 0.04, sgn * 0.11)), (-0.3, 0.85, sgn * 0.28), 0.2, 0.045, "skin", segs=5)
    elif name.startswith("upperArm") or name.startswith("lowerArm"):
        b.collider(part, "skin")
    elif name.startswith("hand"):
        b.collider(part, "skin")
        for i in (-1, 1):
            b.spike(v(c, (0, -0.02, i * 0.02)), (0.2, -1, 0), 0.05, 0.012, "skin")  # claws
    elif name.startswith("upperLeg"):
        b.collider(part, "clothDark")
    elif name.startswith("lowerLeg"):
        b.collider(part, "skin")
    elif name.startswith("foot"):
        b.collider(part, "skinDark")
        for z in (-0.03, 0.0, 0.03):
            b.spike(v(c, (s[0] / 2 - 0.005, -0.01, z)), (1, 0, 0), 0.035, 0.014, "skinDark")  # toes
    else:
        look_default(b, part, spec)


def look_wolf(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "fur")
        b.sphere(v(c, (0.02, 0.03, 0)), 0.15, "fur", scale=(1.1, 1.0, 1.05))  # haunches
        b.box(v(c, (0, -s[1] / 2 + 0.03, 0)), (s[0] - 0.04, 0.06, s[2] + 0.02), "furLight")  # belly
        b.box(v(c, (0, s[1] / 2 - 0.01, 0)), (s[0] - 0.06, 0.03, s[2] + 0.02), "furDark")  # back
    elif name == "chest":
        b.collider(part, "fur")
        b.box(v(c, (0, -s[1] / 2 + 0.03, 0)), (s[0] - 0.06, 0.06, s[2] + 0.02), "furLight")  # belly
        b.sphere(v(c, (s[0] / 2 - 0.06, -0.03, 0)), 0.16, "furLight", scale=(0.9, 1.0, 0.95))  # ruff
        b.box(v(c, (-0.03, s[1] / 2 - 0.01, 0)), (s[0] - 0.1, 0.03, s[2] + 0.02), "furDark")  # back
        b.spike(v(c, (-s[0] / 2 + 0.06, s[1] / 2 - 0.02, 0)), (-0.3, 1, 0), 0.06, 0.04, "furDark")  # hackles
    elif name == "head":
        skull_len = 0.22
        b.box(v(c, (-(s[0] - skull_len) / 2, 0, 0)), (skull_len, s[1], s[2]), "fur")
        snout = v(c, (s[0] / 2 - 0.09, -0.035, 0))
        b.box(snout, (0.2, 0.12, 0.13), "furLight")
        b.sphere(v(snout, (0.1, 0.035, 0)), 0.03, "nose", segs=6, rings=4)
        b.box(v(snout, (0.02, -0.07, 0)), (0.14, 0.03, 0.1), "furDark")  # lower jaw
        b.box(v(snout, (0.07, -0.075, 0)), (0.06, 0.012, 0.04), "tongue")
        for sgn in (-1, 1):
            b.spike(v(c, (-0.07, s[1] / 2 - 0.02, sgn * 0.065)), (-0.15, 1, sgn * 0.2), 0.15, 0.05, "fur")  # ears
            b.spike(v(c, (-0.07, s[1] / 2 - 0.01, sgn * 0.065)), (-0.15, 1, sgn * 0.2), 0.1, 0.028, "furLight")
        b.box(v(c, (-0.11, 0.0, 0)), (0.06, s[1] + 0.02, s[2] + 0.02), "furDark")  # neck ruff
        b.eyes(c, 0.0, 0.045, s[2] / 2 - 0.005, 0.026)
    elif name == "tail":
        b.collider(part, "fur", inflate=0.015)
        top, _ = capsule_ends(part)
        b.sphere(top, 0.055, "furLight")  # bushy tip
    elif name.startswith("upperLeg"):
        b.collider(part, "fur")
        top, _ = capsule_ends(part)
        b.sphere(v(top, (0, -0.02, 0)), 0.085, "fur", scale=(1, 1.1, 0.9))  # thigh / shoulder
    elif name.startswith("lowerLeg"):
        b.collider(part, "furDark")
        _, bottom = capsule_ends(part)
        b.sphere(v(bottom, (0.02, 0.01, 0)), 0.055, "furDark", scale=(1.2, 0.7, 1))  # paw
    else:
        look_default(b, part, spec)


def look_chicken(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "body":
        r = s[0]
        b.sphere(c, r, "feathers", scale=(1.05, 0.92, 0.9))
        b.sphere(v(c, (0.02, -0.05, 0)), r * 0.7, "feathersDark", scale=(1.1, 0.7, 1.05))  # breast
        for (dx, dy, z) in ((-0.9, 0.35, 0.0), (-0.7, 0.7, -0.03), (-0.7, 0.7, 0.03), (-0.4, 0.9, 0.0)):
            b.spike(v(c, (-r * 0.7, 0.06, z)), (dx, dy, 0), 0.12, 0.028, "feathersDark")  # fanned tail feathers
    elif name == "head":
        r = s[0]
        b.sphere(c, r, "feathers")
        b.cone(v(c, (r + 0.02, -0.005, 0)), 0.025, 0.004, 0.07, "beak", rot=[0, 0, -90])  # beak
        b.sphere(v(c, (r - 0.02, -0.055, 0)), 0.022, "comb", scale=(1, 1.3, 0.7), segs=6, rings=4)  # wattle
        for (dx, dy) in ((-0.03, 0.065), (0.0, 0.075), (0.03, 0.065)):
            b.sphere(v(c, (dx, dy, 0)), 0.024, "comb", scale=(1, 1.2, 0.6), segs=6, rings=4)  # comb
        b.eyes(c, 0.04, 0.015, r - 0.01, 0.014, white=False)
    elif name.startswith("wing"):
        sgn = -1 if part.get("side") == "L" else 1
        b.sphere(v(c, (0.0, 0.0, 0.0)), s[0] / 2, "feathersDark", scale=(1, s[1] / s[0], s[2] / s[0] * 0.9))
        b.spike(v(c, (-s[0] / 2 + 0.03, -0.02, 0)), (-1, -0.3, 0), 0.06, 0.03, "feathersDark")  # wing tip
    elif name.startswith("upperLeg"):
        b.collider(part, "legs")
    elif name.startswith("foot"):
        b.box(v(c, (-0.01, 0, 0)), (s[0] - 0.04, s[1], s[2] - 0.02), "legs")
        for z in (-0.03, 0.0, 0.03):
            b.spike(v(c, (s[0] / 2 - 0.04, 0, z)), (1, 0, z * 3), 0.05, 0.012, "legs")  # toes
        b.spike(v(c, (-s[0] / 2 + 0.03, 0, 0)), (-1, 0, 0), 0.03, 0.01, "legs")  # back toe
    else:
        look_default(b, part, spec)


LOOKS = {"knight": look_knight, "goblin": look_goblin, "wolf": look_wolf, "chicken": look_chicken}


# ----------------------------------------------------------------------------- scene assembly

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    for block_list in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for block in list(block_list):
            block_list.remove(block)


def make_materials(spec):
    colors = dict(BUILTIN_COLORS)
    colors.update(spec.get("palette", {}))
    index = {}
    mats = []
    for name, hex_col in colors.items():
        m = bpy.data.materials.new(f"{spec['id']}_{name}")
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        rgba = hex_to_linear(hex_col)
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Roughness"].default_value = 0.85
            bsdf.inputs["Specular IOR Level"].default_value = 0.2
        m.diffuse_color = rgba  # used by Workbench previews
        m.roughness = 0.85
        index[name] = len(mats)
        mats.append(m)
    return index, mats


def build_armature(spec):
    arm_data = bpy.data.armatures.new(f"{spec['id']}_armature")
    arm_obj = bpy.data.objects.new(f"{spec['id']}_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    arm_obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bones = {}
    for part in spec["parts"]:
        eb = arm_data.edit_bones.new(part["name"])
        head = SPEC_TO_BLENDER @ Vector(part["pos"])
        eb.head = head
        # Bone points along Blender +Z (= glTF +Y). With roll 0 that is Rx(+90) in Blender, and
        # the exporter's Y-up basis change (Rx(-90)) cancels it, so every bone's world rest
        # rotation in the GLB is the identity.
        eb.tail = head + Vector((0.0, 0.0, 0.08))
        eb.roll = 0.0
        eb.use_connect = False
        eb.use_deform = True
        bones[part["name"]] = eb
    for part in spec["parts"]:
        if part.get("parent"):
            bones[part["name"]].parent = bones[part["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


def build_mesh(spec, arm_obj, mat_index, mats):
    b = MeshBuilder(mat_index)
    look = LOOKS.get(spec["id"], look_default)
    for i, part in enumerate(spec["parts"]):
        b.begin_part(i)
        look(b, part, spec)
    # materials that were created lazily (unknown names) need a magenta material
    while len(mats) < len(b.materials):
        m = bpy.data.materials.new(f"{spec['id']}_missing{len(mats)}")
        m.diffuse_color = (1, 0, 1, 1)
        mats.append(m)

    mesh = bpy.data.meshes.new(f"{spec['id']}_mesh")
    mesh.from_pydata(b.verts, [], b.faces)
    mesh.update()
    for m in mats:
        mesh.materials.append(m)
    for poly, mi in zip(mesh.polygons, b.face_mats):
        poly.material_index = mi
    for poly in mesh.polygons:
        poly.use_smooth = False
    mesh.validate(verbose=False)

    obj = bpy.data.objects.new(f"{spec['id']}_body", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = arm_obj
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm_obj
    mod.use_vertex_groups = True

    per_part = {}
    for vi, pi in enumerate(b.vert_part):
        per_part.setdefault(pi, []).append(vi)
    for i, part in enumerate(spec["parts"]):
        vg = obj.vertex_groups.new(name=part["name"])
        vg.add(per_part.get(i, []), 1.0, "REPLACE")

    tris = sum(len(f) - 2 for f in b.faces)
    print(f"  mesh: {len(b.verts)} verts, {len(b.faces)} faces, ~{tris} tris")
    return obj, tris


def spec_bounds(spec):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for p in spec["parts"]:
        c, s = Vector(p["pos"]), p["size"]
        if p["shape"] == "box":
            half = Vector(s) * 0.5
            corners = [c + Vector((sx * half.x, sy * half.y, sz * half.z))
                       for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
            corners = [(rot_matrix(p.get("rot")) @ (k - c)) + c for k in corners]
        elif p["shape"] == "sphere":
            corners = [c + Vector((sx, sy, sz)) * s[0] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        else:
            a, bb = capsule_ends(p)
            corners = [e + Vector((sx, sy, sz)) * s[0] for e in (a, bb)
                       for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        for k in corners:
            for i in range(3):
                lo[i] = min(lo[i], k[i])
                hi[i] = max(hi[i], k[i])
    return Vector(lo), Vector(hi)


def render_preview(spec, path):
    scene = bpy.context.scene
    lo, hi = spec_bounds(spec)
    center = (lo + hi) * 0.5
    extent = max(hi.x - lo.x, hi.y - lo.y) * 1.35 + 0.1

    cam_data = bpy.data.cameras.new("preview_cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = extent
    cam_data.clip_start = 0.01
    cam_data.clip_end = 100.0
    cam = bpy.data.objects.new("preview_cam", cam_data)
    scene.collection.objects.link(cam)
    # spec +Z is Blender -Y: camera sits at -Y looking toward +Y, screen-right = +X (facing dir)
    cam.location = SPEC_TO_BLENDER @ Vector((center.x, center.y, 10.0))
    cam.rotation_euler = Euler((math.radians(90.0), 0.0, 0.0), "XYZ")
    scene.camera = cam

    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_shadows = False
    sh.show_cavity = False
    sh.show_object_outline = True
    sh.background_type = "VIEWPORT"
    sh.background_color = (1.0, 1.0, 1.0)
    if scene.world is None:
        scene.world = bpy.data.worlds.new("preview_world")
    scene.world.color = (1.0, 1.0, 1.0)

    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    scene.collection.objects.unlink(cam)
    bpy.data.objects.remove(cam)
    print(f"  preview -> {path}")


def build_creature(spec_path, do_export=True, do_preview=False):
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    cid = spec["id"]
    print(f"[{cid}] building from {spec_path}")
    reset_scene()
    mat_index, mats = make_materials(spec)
    arm_obj = build_armature(spec)
    mesh_obj, tris = build_mesh(spec, arm_obj, mat_index, mats)
    if tris > 3000:
        print(f"  [warn] {tris} tris exceeds the 3000 budget")

    bpy.ops.object.select_all(action="DESELECT")
    arm_obj.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    if do_export:
        os.makedirs(OUT_DIR, exist_ok=True)
        out = os.path.join(OUT_DIR, f"{cid}.glb")
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_skins=True,
            export_animations=False,
            export_materials="EXPORT",
            export_def_bones=False,
            export_rest_position_armature=True,
            use_selection=False,
        )
        print(f"  exported -> {out} ({os.path.getsize(out)} bytes)")
    if do_preview:
        os.makedirs(PREVIEW_DIR, exist_ok=True)
        render_preview(spec, os.path.join(PREVIEW_DIR, f"{cid}.png"))


def main():
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    do_preview = "--preview" in args
    do_export = "--no-export" not in args
    ids = [a for a in args if not a.startswith("--")]

    if ids:
        paths = []
        for a in ids:
            if os.path.isfile(a):
                paths.append(os.path.abspath(a))
            else:
                paths.append(os.path.join(SPEC_DIR, f"{a}.json"))
    else:
        paths = sorted(os.path.join(SPEC_DIR, f) for f in os.listdir(SPEC_DIR) if f.endswith(".json"))

    failures = []
    for p in paths:
        try:
            build_creature(p, do_export=do_export, do_preview=do_preview)
        except Exception as exc:  # keep going so one bad spec doesn't hide the others
            import traceback
            traceback.print_exc()
            failures.append((p, str(exc)))
    if failures:
        for p, e in failures:
            print(f"FAILED {p}: {e}")
        sys.exit(1)
    print("done.")


if __name__ == "__main__":
    main()
