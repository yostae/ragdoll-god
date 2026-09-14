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

    def eyes(self, center, forward_offset, up_offset, z_half, r, white=True, pupil_r=None,
             white_mat="eyeWhite", pupil_mat="eye"):
        """Pair of eyes on the +Z/-Z sides of a head so they read from the side camera."""
        pupil_r = pupil_r or r * 0.55
        for sgn in (-1, 1):
            p = (center[0] + forward_offset, center[1] + up_offset, center[2] + sgn * z_half)
            if white:
                self.sphere(p, r, white_mat, segs=6, rings=4)
                self.sphere((p[0] + r * 0.25, p[1], p[2] + sgn * r * 0.55), pupil_r, pupil_mat, segs=6, rings=4)
            else:
                self.sphere(p, r, pupil_mat, segs=6, rings=4)

    def front_eyes(self, center, hx, up_offset, z_gap, r, white_mat="eyeWhite", pupil_mat="eye"):
        """Pair of eyes on the +X (front) face, for the 3D view; z_gap = distance from the centre line."""
        for sgn in (-1, 1):
            p = (center[0] + hx, center[1] + up_offset, center[2] + sgn * z_gap)
            self.sphere(p, r, white_mat, segs=6, rings=4)
            self.sphere((p[0] + r * 0.55, p[1], p[2]), r * 0.55, pupil_mat, segs=6, rings=4)

    def bands(self, part, mat, count, inflate=0.006, width=0.03, start=0.15, end=0.85):
        """Thin rings around a capsule (bandages / cuffs), spaced along its axis."""
        top, bottom = capsule_ends(part)
        r = part["size"][0] + inflate
        for i in range(count):
            t = start + (end - start) * (i / max(1, count - 1))
            c = bottom.lerp(top, t)
            self.cone(c, r, r, width, mat, rot=part.get("rot"), segs=8)

    def slabs(self, part, mat, count, inflate=0.006, height=0.03, start=0.15, end=0.85):
        """Thin horizontal slabs around a box part (stripes on a shirt, bandages on a torso)."""
        c, s = part["pos"], part["size"]
        for i in range(count):
            t = start + (end - start) * (i / max(1, count - 1))
            y = c[1] - s[1] / 2 + s[1] * t
            self.box((c[0], y, c[2]), (s[0] + 2 * inflate, height, s[2] + 2 * inflate), mat)

    def joint_knob(self, part, r, mat, which="both"):
        """Spheres on the capsule ends (elbows / knees / bony joints)."""
        top, bottom = capsule_ends(part)
        if which in ("both", "top"):
            self.sphere(top, r, mat, segs=6, rings=4)
        if which in ("both", "bottom"):
            self.sphere(bottom, r, mat, segs=6, rings=4)


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


# ----------------------------------------------------------------------------- shared biped helpers

def head_dims(part):
    """(center, half x, half y, half z) of a head part regardless of shape."""
    c, s = part["pos"], part["size"]
    if part["shape"] == "box":
        return c, s[0] / 2, s[1] / 2, s[2] / 2
    return c, s[0], s[0], s[0]


def limb_material(name, mats):
    """Material for a standard biped limb part from a dict keyed by role prefix, else None."""
    for key in ("upperArm", "lowerArm", "hand", "upperLeg", "lowerLeg", "foot"):
        if name.startswith(key):
            return mats.get(key)
    return None


def plain_limb(b, part, mats, inflate=0.0, toe=None):
    """Draw a standard biped limb as its collider in a per-role material. Returns True if handled."""
    name = part["name"]
    mat = limb_material(name, mats)
    if mat is None:
        return False
    b.collider(part, mat, inflate=inflate)
    if name.startswith("foot") and toe:
        c, s = part["pos"], part["size"]
        b.sphere(v(c, (s[0] / 2 - s[2] * 0.2, 0, 0)), s[2] * 0.32, toe, scale=(1, 0.9, 1.4), segs=6, rings=4)
    return True


def cape(b, torso, mat, collar=None, drop=0.3, width_pad=0.06):
    """Thin cloth box hanging from the back of a torso part (drawn as part of the torso chunk)."""
    c, s = torso["pos"], torso["size"]
    length = s[1] + drop
    b.box((c[0] - s[0] / 2 - 0.02, c[1] + s[1] / 2 - length / 2, c[2]), (0.03, length, s[2] + width_pad), mat)
    if collar:
        b.box((c[0] - 0.02, c[1] + s[1] / 2 + 0.005, c[2]), (s[0] - 0.02, 0.03, s[2] + width_pad), collar)


def lightning_bolt(b, center, mat, height=0.16, thick=0.012, axis="x"):
    """Zig-zag bolt of three flat boxes lying on a face whose normal is `axis` ('x' or 'z')."""
    seg = height * 0.42
    w = height * 0.22
    for i, (dy, dz, ang) in enumerate(((0.36, 0.15, 30), (0.0, -0.1, -30), (-0.36, 0.15, 30))):
        off_y = dy * height
        off_w = dz * height
        if axis == "x":
            b.box((center[0], center[1] + off_y, center[2] + off_w), (thick, seg, w), mat, rot=[ang, 0, 0])
        else:
            b.box((center[0] + off_w, center[1] + off_y, center[2]), (w, seg, thick), mat, rot=[0, 0, -ang])


def ragged_hem(b, part, mat, length=0.07, r=0.03, count=6, pad=0.02):
    """Downward spikes around the bottom edge of a box part (torn tunic / loincloth)."""
    c, s = part["pos"], part["size"]
    hem = -s[1] / 2 + 0.03
    pts = [(s[0] / 2 + pad, 0.0), (-s[0] / 2 - pad, 0.0), (0.0, s[2] / 2 + pad), (0.0, -s[2] / 2 - pad),
           (s[0] * 0.25, s[2] / 2 + pad), (-s[0] * 0.25, -s[2] / 2 - pad)]
    for (x, z) in pts[:count]:
        b.spike(v(c, (x, hem, z)), (0, -1, 0), length, r, mat)


# ----------------------------------------------------------------------------- base creatures

def look_farmer(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "overalls")
    elif name == "torso":
        b.collider(part, "shirt")
        b.box(v(c, (s[0] / 2, -0.03, 0)), (0.03, s[1] * 0.8, s[2] * 0.7), "overalls")  # bib
        b.box(v(c, (-s[0] / 2, -0.03, 0)), (0.03, s[1] * 0.8, s[2] * 0.7), "overalls")  # back
        for z in (-0.06, 0.06):
            b.box(v(c, (0, s[1] / 2, z)), (s[0] + 0.02, 0.025, 0.04), "overallsDark")  # straps
        for z in (-0.06, 0.06):
            b.sphere(v(c, (s[0] / 2 + 0.01, s[1] * 0.28, z)), 0.014, "hatDark", segs=6, rings=4)  # buttons
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "skin")
        b.box(v(c, (0.02, -hy + 0.03, 0)), (hx * 2 + 0.03, 0.09, hz * 2 + 0.03), "beard")  # beard block
        b.sphere(v(c, (hx, 0.0, 0)), 0.03, "skin", segs=6, rings=4)  # nose
        b.eyes(c, hx * 0.35, hy * 0.25, hz, 0.024)
        b.front_eyes(c, hx, hy * 0.25, 0.06, 0.02)
        b.cone(v(c, (0, hy + 0.012, 0)), 0.18, 0.18, 0.02, "hat", segs=10)  # straw brim
        b.cone(v(c, (0, hy + 0.06, 0)), 0.13, 0.11, 0.08, "hat", segs=10)  # crown
        b.cone(v(c, (0, hy + 0.035, 0)), 0.135, 0.135, 0.02, "hatDark", segs=10)  # hat band
    elif not plain_limb(b, part, {"upperArm": "shirt", "lowerArm": "shirt", "hand": "skin", "upperLeg": "overalls",
                                  "lowerLeg": "overalls", "foot": "boots"}, toe="boots"):
        look_default(b, part, spec)


def look_kid(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "shorts")
    elif name == "torso":
        b.collider(part, "shirt")
        b.slabs(part, "stripe", 3, height=0.035, start=0.2, end=0.8)
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "skin")
        b.eyes(c, hx * 0.35, hy * 0.1, hz, 0.03)
        b.front_eyes(c, hx, hy * 0.1, 0.06, 0.026)
        b.sphere(v(c, (hx, -hy * 0.15, 0)), 0.018, "skin", segs=6, rings=4)  # nose
        b.box(v(c, (hx, -hy * 0.5, 0)), (0.015, 0.02, 0.08), "stripe")  # grin
        b.sphere(v(c, (0, hy - 0.03, 0)), hx + 0.012, "cap", scale=(1.0, 0.45, 1.0))  # cap dome
        b.box(v(c, (-hx - 0.05, hy - 0.01, 0)), (0.12, 0.018, hz * 1.5), "capDark")  # backwards brim
        b.box(v(c, (hx, hy - 0.06, 0)), (0.02, 0.05, hz * 1.8), "hair")  # fringe
        for sgn in (-1, 1):
            b.box(v(c, (0.02, hy - 0.06, sgn * hz)), (hx * 1.6, 0.05, 0.02), "hair")
    elif name.startswith("foot"):
        b.box(v(c, (0, 0.012, 0)), (s[0], s[1] - 0.024, s[2]), "sneaker")
        b.box(v(c, (0, -s[1] / 2 + 0.012, 0)), (s[0] + 0.01, 0.024, s[2] + 0.01), "sneakerSole")
        b.sphere(v(c, (s[0] / 2 - 0.02, 0.005, 0)), s[2] * 0.36, "sneaker", scale=(1, 0.8, 1.3), segs=6, rings=4)
        b.box(v(c, (s[0] / 2 - 0.045, s[1] / 2, 0)), (0.05, 0.012, s[2] * 0.6), "stripe")  # laces
    elif not plain_limb(b, part, {"upperArm": "shirt", "lowerArm": "skin", "hand": "skin", "upperLeg": "shorts",
                                  "lowerLeg": "skin"}):
        look_default(b, part, spec)


def look_giant(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "tunicDark")
        ragged_hem(b, part, "tunicDark", length=0.16, r=0.06, pad=0.03)
    elif name == "torso":
        b.collider(part, "skin")
        b.box(v(c, (0, -0.05, 0)), (s[0] + 0.06, s[1] - 0.1, s[2] + 0.06), "tunic")  # ragged tunic, one shoulder bare
        b.box(v(c, (0, s[1] / 2 - 0.08, -s[2] * 0.3)), (s[0] + 0.06, 0.16, s[2] * 0.4), "tunic")  # strap over the left shoulder
        ragged_hem(b, part, "tunic", length=0.18, r=0.07, pad=0.04)
        b.box(v(c, (s[0] / 2 + 0.03, -0.1, 0)), (0.03, 0.06, s[2] * 0.7), "boots")  # rope belt
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "skin")
        b.box(v(c, (hx, hy * 0.28, 0)), (0.04, 0.07, hz * 1.7), "brow")  # unibrow, front
        for sgn in (-1, 1):
            b.box(v(c, (hx * 0.45, hy * 0.28, sgn * hz)), (hx * 1.1, 0.07, 0.04), "brow")  # wraps the sides
            b.sphere(v(c, (-hx * 0.4, 0.0, sgn * hz)), 0.07, "skin", scale=(0.6, 1, 0.5), segs=6, rings=4)  # ears
        b.eyes(c, hx * 0.4, hy * 0.02, hz, 0.05)
        b.front_eyes(c, hx, hy * 0.02, 0.11, 0.045)
        b.sphere(v(c, (hx, -hy * 0.2, 0)), 0.08, "skinDark", segs=6, rings=4)  # big nose
        b.box(v(c, (hx, -hy * 0.6, 0)), (0.03, 0.03, hz * 1.1), "brow")  # frown
    elif name.startswith("hand"):
        b.collider(part, "skin")
        for z in (-0.06, 0.0, 0.06):
            b.sphere(v(c, (s[0] * 0.75, -s[0] * 0.45, z)), 0.05, "skinDark", segs=6, rings=4)  # knuckles
    elif name.startswith("foot"):
        b.collider(part, "skinDark")
        for z in (-s[2] * 0.3, 0.0, s[2] * 0.3):
            b.sphere(v(c, (s[0] / 2, -0.02, z)), 0.06, "skin", segs=6, rings=4)  # toes
    elif not plain_limb(b, part, {"upperArm": "skin", "lowerArm": "skin", "upperLeg": "skin", "lowerLeg": "skin"}):
        look_default(b, part, spec)


def look_skeleton(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.box(c, (s[0] * 0.9, s[1] * 0.8, s[2] * 0.7), "boneDark")
        for sgn in (-1, 1):
            b.sphere(v(c, (sgn * s[0] * 0.42, 0.0, 0)), 0.07, "bone", scale=(0.8, 1, 1), segs=6, rings=4)  # hip bones
    elif name == "torso":
        b.box(c, (s[0] * 0.55, s[1] * 0.95, s[2] * 0.5), "socket")  # dark hollow inside the ribcage
        b.box(v(c, (-s[0] / 2 + 0.03, 0, 0)), (0.06, s[1], 0.06), "bone")  # spine
        b.box(v(c, (0, s[1] / 2 - 0.02, 0)), (s[0], 0.04, s[2]), "bone")  # collar bones
        b.slabs(part, "ribs", 4, inflate=0.0, height=0.028, start=0.12, end=0.72)
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.sphere(c, hx * 1.05, "bone", scale=(1.0, hy / hx * 1.05, hz / hx))  # cranium
        b.box(v(c, (hx * 0.35, -hy * 0.8, 0)), (hx * 1.3, hy * 0.45, hz * 1.5), "bone")  # jaw
        b.eyes(c, hx * 0.35, hy * 0.1, hz * 0.98, 0.045, white=False, pupil_mat="socket")
        b.front_eyes(c, hx * 0.9, hy * 0.1, 0.06, 0.035, white_mat="socket", pupil_mat="socket")
        b.spike(v(c, (hx * 0.95, -hy * 0.35, 0)), (0, 1, 0), 0.05, 0.02, "socket", segs=4)  # nose hole
        b.box(v(c, (hx * 1.0, -hy * 0.65, 0)), (0.02, 0.02, hz * 1.2), "socket")  # mouth gap
        for z in (-0.06, -0.02, 0.02, 0.06):
            b.box(v(c, (hx * 1.0, -hy * 0.65, z)), (0.024, 0.03, 0.012), "bone")  # teeth
    elif name.startswith("foot"):
        b.box(v(c, (0, -0.01, 0)), (s[0], s[1] * 0.55, s[2] * 0.6), "bone")
        for z in (-0.03, 0.0, 0.03):
            b.spike(v(c, (s[0] / 2, -0.01, z)), (1, 0, 0), 0.03, 0.012, "bone")  # toes
    elif name.startswith("hand"):
        b.collider(part, "bone")
    else:
        mat = limb_material(name, {"upperArm": "bone", "lowerArm": "bone", "upperLeg": "bone", "lowerLeg": "bone"})
        if mat is None:
            return look_default(b, part, spec)
        b.collider(part, mat)
        b.joint_knob(part, s[0] * 1.5, "boneDark", which="both")  # knobbly joint ends


def look_slime(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "body":
        r = s[0]
        b.sphere(c, r, "goo", scale=(1.0, 0.95, 1.0))
        b.sphere(v(c, (0, -r * 0.55, 0)), r * 0.9, "gooDark", scale=(1.15, 0.45, 1.15))  # squashed base
        b.sphere(v(c, (r * 0.3, r * 0.6, r * 0.45)), r * 0.2, "gooLight", scale=(1.2, 0.6, 1.0), segs=6, rings=4)  # highlight
    elif name == "head":
        r = s[0]
        b.sphere(c, r, "goo", scale=(1.0, 0.9, 1.0))
        b.eyes(c, r * 0.35, r * 0.15, r * 0.82, 0.05)
        b.front_eyes(c, r * 0.85, r * 0.15, 0.06, 0.045)
        b.box(v(c, (r * 0.95, -r * 0.35, 0)), (0.02, 0.03, 0.1), "mouth")  # mouth
        b.sphere(v(c, (-r * 0.2, r * 0.95, 0)), r * 0.25, "goo", scale=(1, 0.8, 1), segs=6, rings=4)  # drip on top
    elif name.startswith("nub"):
        b.collider(part, "goo")
        top, _ = capsule_ends(part)
        b.sphere(top, s[0] * 1.3, "gooLight", segs=6, rings=4)
    elif name.startswith("upperLeg"):
        b.collider(part, "gooDark")
        _, bottom = capsule_ends(part)
        b.sphere(v(bottom, (0.01, 0.02, 0)), s[0] * 1.6, "gooDark", scale=(1.3, 0.6, 1.1), segs=6, rings=4)  # blobby foot
    else:
        look_default(b, part, spec)


# ----------------------------------------------------------------------------- heroes pack

def look_captainzap(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "suitDark")
        b.box(v(c, (0, s[1] / 2 - 0.02, 0)), (s[0] + 0.02, 0.04, s[2] + 0.02), "bolt")  # belt
    elif name == "torso":
        b.collider(part, "suit")
        lightning_bolt(b, v(c, (s[0] / 2 + 0.008, 0.02, 0)), "bolt", height=0.2, axis="x")
        for sgn in (-1, 1):
            lightning_bolt(b, v(c, (0.0, 0.02, sgn * (s[2] / 2 + 0.008))), "bolt", height=0.14, axis="z")
        cape(b, part, "cape", collar="cape", drop=0.32)
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "skin")
        b.box(v(c, (hx + 0.002, hy * 0.15, 0)), (0.015, 0.07, hz * 2 + 0.03), "mask")  # domino mask front
        for sgn in (-1, 1):
            b.box(v(c, (0.02, hy * 0.15, sgn * (hz + 0.002))), (hx * 1.7, 0.07, 0.015), "mask")  # and sides
        b.eyes(c, hx * 0.35, hy * 0.15, hz + 0.008, 0.025)
        b.front_eyes(c, hx + 0.01, hy * 0.15, 0.055, 0.02)
        b.box(v(c, (0, hy, 0)), (hx * 1.8, 0.04, hz * 2 + 0.01), "hair")
        b.sphere(v(c, (hx * 0.7, hy + 0.04, 0)), 0.05, "hair", scale=(1.2, 0.8, 1.0), segs=6, rings=4)  # quiff
        b.box(v(c, (hx, -hy * 0.55, 0)), (0.015, 0.015, 0.07), "mask")  # confident grin
        b.box(v(c, (hx * 0.6, -hy * 0.9, 0)), (hx * 1.0, 0.03, hz * 1.4), "skin")  # chin
    elif not plain_limb(b, part, {"upperArm": "suit", "lowerArm": "suit", "hand": "bolt", "upperLeg": "suit",
                                  "lowerLeg": "suit", "foot": "boots"}, toe="boots"):
        look_default(b, part, spec)


def look_rocketgirl(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "suitDark")
    elif name == "torso":
        b.collider(part, "suit")
        b.box(v(c, (s[0] / 2, s[1] * 0.2, 0)), (0.02, 0.06, s[2] * 0.6), "helmet")  # chest panel
        for z in (-0.07, 0.07):
            b.box(v(c, (0, s[1] / 2 - 0.02, z)), (s[0] + 0.02, 0.03, 0.04), "jetDark")  # straps
            base = v(c, (-s[0] / 2 - 0.07, -0.02, z))
            b.cone(base, 0.05, 0.05, 0.3, "jet", segs=8)  # jetpack tanks
            b.cone(v(base, (0, 0.17, 0)), 0.05, 0.03, 0.04, "jetDark", segs=8)  # cap
            b.cone(v(base, (0, -0.18, 0)), 0.06, 0.045, 0.06, "jetDark", segs=8)  # nozzle
            b.cone(v(base, (0, -0.25, 0)), 0.02, 0.045, 0.08, "flame", segs=6)  # little flame
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        r = hx * 1.22
        b.sphere(c, r, "helmet", scale=(1.0, hy / hx * 1.15, hz / hx * 1.05))
        b.box(v(c, (r * 0.8, 0.02, 0)), (0.06, 0.11, hz * 1.5), "visor")  # visor front
        for sgn in (-1, 1):
            b.box(v(c, (0.04, 0.02, sgn * (r * 0.9))), (hx * 1.4, 0.11, 0.03), "visor")  # visor wraps the sides
        b.eyes(c, hx * 0.35, 0.03, r * 0.9 + 0.01, 0.022)
        b.front_eyes(c, r * 0.8 + 0.02, 0.03, 0.05, 0.02)
        b.box(v(c, (r * 0.4, 0.02, 0)), (r, 0.02, hz * 2 + 0.05), "suit")  # red visor rim
        b.sphere(v(c, (-r * 0.5, r * 0.6, 0)), 0.04, "suit", segs=6, rings=4)  # antenna nub
    elif not plain_limb(b, part, {"upperArm": "suit", "lowerArm": "suit", "hand": "gloves", "upperLeg": "suit",
                                  "lowerLeg": "suitDark", "foot": "gloves"}, toe="gloves"):
        look_default(b, part, spec)


def look_drskull(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "black")
    elif name == "torso":
        b.collider(part, "black")
        drop = 0.16
        length = s[1] + drop
        yc = c[1] + s[1] / 2 - length / 2
        b.box((c[0] - s[0] / 2 - 0.005, yc, c[2]), (0.03, length, s[2] + 0.05), "coat")  # back panel
        for sgn in (-1, 1):
            b.box((c[0], yc, c[2] + sgn * (s[2] / 2 + 0.012)), (s[0] + 0.03, length, 0.03), "coat")  # side panels
            b.box((c[0] + s[0] / 2 + 0.005, yc, c[2] + sgn * (s[2] * 0.28)), (0.03, length, s[2] * 0.44), "coat")  # open front
            b.box((c[0] + s[0] / 2 + 0.02, c[1] + s[1] * 0.3, c[2] + sgn * (s[2] * 0.2)), (0.02, 0.1, 0.05), "coatDark",
                  rot=[sgn * 25, 0, 0])  # lapels
        b.box(v(c, (s[0] / 2 + 0.03, -0.02, 0)), (0.02, 0.05, 0.04), "lens")  # glowing vial in the pocket
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.sphere(c, hx * 1.05, "skull", scale=(1.0, hy / hx * 1.05, hz / hx))
        b.box(v(c, (hx * 0.35, -hy * 0.8, 0)), (hx * 1.3, hy * 0.45, hz * 1.4), "skull")  # jaw
        b.box(v(c, (0, hy * 0.2, 0)), (hx * 2 + 0.03, 0.05, hz * 2 + 0.03), "black")  # goggle strap
        for sgn in (-1, 1):
            p = v(c, (hx * 0.35, hy * 0.2, sgn * (hz + 0.01)))
            b.cone(p, 0.05, 0.05, 0.03, "goggle", rot=[90, 0, 0], segs=8)  # goggle rims on the sides
            b.cone(v(p, (0, 0, sgn * 0.018)), 0.038, 0.038, 0.012, "lens", rot=[90, 0, 0], segs=8)
        for sgn in (-1, 1):
            p = v(c, (hx * 1.0, hy * 0.2, sgn * 0.06))
            b.cone(p, 0.045, 0.045, 0.03, "goggle", rot=[0, 0, -90], segs=8)  # and on the front
            b.cone(v(p, (0.018, 0, 0)), 0.034, 0.034, 0.012, "lens", rot=[0, 0, -90], segs=8)
        b.box(v(c, (hx * 1.0, -hy * 0.55, 0)), (0.02, 0.02, hz * 1.1), "socket")  # grin gap
        for z in (-0.05, -0.017, 0.017, 0.05):
            b.box(v(c, (hx * 1.0, -hy * 0.55, z)), (0.024, 0.03, 0.012), "skull")  # teeth
    elif not plain_limb(b, part, {"upperArm": "coat", "lowerArm": "coat", "hand": "gloves", "upperLeg": "black",
                                  "lowerLeg": "black", "foot": "black"}):
        look_default(b, part, spec)


def look_robobrute(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "metalDark")
        b.box(v(c, (0, 0, 0)), (s[0] * 0.6, s[1] + 0.02, s[2] * 0.6), "metal")  # hip block
    elif name == "torso":
        b.collider(part, "metal")
        b.box(v(c, (s[0] / 2, 0.02, 0)), (0.04, s[1] * 0.7, s[2] * 0.75), "metalLight")  # chest plate
        b.box(v(c, (s[0] / 2 + 0.02, -0.05, 0)), (0.02, 0.05, s[2] * 0.4), "eyeRed")  # warning light strip
        for sgn in (-1, 1):
            b.box(v(c, (0, s[1] / 2 + 0.03, sgn * (s[2] / 2 - 0.04))), (s[0] * 0.8, 0.08, 0.1), "metalDark")  # shoulder blocks
            for x in (-s[0] * 0.3, s[0] * 0.3):
                b.sphere(v(c, (x, s[1] * 0.3, sgn * (s[2] / 2 + 0.005))), 0.03, "metalDark", segs=6, rings=4)  # rivets
        b.box(v(c, (-s[0] / 2 - 0.03, 0, 0)), (0.06, s[1] * 0.6, s[2] * 0.6), "metalDark")  # back vent box
        b.slabs(part, "metalDark", 2, inflate=0.005, height=0.02, start=0.3, end=0.6)
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "metal")
        b.box(v(c, (hx + 0.006, hy * 0.15, 0)), (0.015, 0.06, hz * 1.75), "eyeRed")  # glowing eye slit, front
        for sgn in (-1, 1):
            b.box(v(c, (hx * 0.4, hy * 0.15, sgn * (hz + 0.006))), (hx * 1.2, 0.06, 0.015), "eyeRed")  # wraps the sides
        b.box(v(c, (hx + 0.004, -hy * 0.5, 0)), (0.012, 0.07, hz * 1.4), "metalDark")  # mouth grille
        for z in (-hz * 0.45, -hz * 0.15, hz * 0.15, hz * 0.45):
            b.box(v(c, (hx + 0.01, -hy * 0.5, z)), (0.012, 0.07, 0.012), "metalLight")
        b.box(v(c, (0, hy + 0.01, 0)), (hx * 1.6, 0.03, hz * 1.6), "metalDark")  # head plate
        base = v(c, (-hx * 0.3, hy + 0.02, 0))
        b.cone(v(base, (0, 0.13, 0)), 0.018, 0.012, 0.26, "metalDark", segs=6)  # antenna
        b.sphere(v(base, (0, 0.28, 0)), 0.045, "eyeRed", segs=6, rings=4)
        for sgn in (-1, 1):
            b.box(v(c, (-hx * 0.5, 0, sgn * (hz + 0.01))), (0.1, hy * 0.8, 0.03), "metalDark")  # side vents
    elif name.startswith("hand"):
        b.box(v(c, (0, s[1] / 2 - 0.03, 0)), (s[0], 0.06, s[2]), "metalDark")  # wrist block
        b.box(v(c, (s[0] / 2 - 0.03, -0.03, 0)), (0.06, s[1] - 0.06, s[2] * 0.8), "metal")  # front prong
        b.box(v(c, (-s[0] / 2 + 0.03, -0.03, 0)), (0.06, s[1] - 0.06, s[2] * 0.8), "metal")  # back prong
        b.box(v(c, (s[0] / 2 - 0.03, -s[1] / 2 + 0.02, 0)), (0.08, 0.04, s[2] * 0.6), "metalLight")  # pincer tips
        b.box(v(c, (-s[0] / 2 + 0.03, -s[1] / 2 + 0.02, 0)), (0.08, 0.04, s[2] * 0.6), "metalLight")
    elif name.startswith("foot"):
        b.collider(part, "metalDark")
        b.box(v(c, (s[0] / 2 - 0.04, 0.01, 0)), (0.08, s[1] + 0.02, s[2] + 0.02), "metalLight")  # toe cap
    else:
        mats = {"upperArm": "metal", "lowerArm": "metalLight", "upperLeg": "metal", "lowerLeg": "metalLight"}
        mat = limb_material(name, mats)
        if mat is None:
            return look_default(b, part, spec)
        r, length = s[0], s[1]
        b.box(c, (r * 2, length + r * 1.6, r * 2), mat)  # boxy limb over the capsule collider
        b.joint_knob(part, r * 0.9, "rubber", which="both")
        b.box(c, (r * 2.1, 0.03, r * 2.1), "metalDark")  # ring around the middle


# ----------------------------------------------------------------------------- monsters pack

def look_cyclops(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "clothDark")
        b.box(v(c, (0, s[1] / 2 - 0.02, 0)), (s[0] + 0.03, 0.05, s[2] + 0.03), "cloth")  # belt
        ragged_hem(b, part, "clothDark", length=0.14, r=0.05, pad=0.03)
    elif name == "torso":
        b.collider(part, "skin")
        for sgn in (-1, 1):
            b.sphere(v(c, (s[0] / 2 - 0.02, s[1] * 0.2, sgn * s[2] * 0.25)), 0.09, "skin", scale=(0.6, 1, 1), segs=6, rings=4)  # pecs
        b.sphere(v(c, (s[0] / 2 - 0.05, -s[1] * 0.25, 0)), 0.15, "skinDark", scale=(0.6, 1, 1.2), segs=6, rings=4)  # belly
        b.box(v(c, (0.0, -s[1] / 2 + 0.02, 0)), (s[0] + 0.03, 0.05, s[2] + 0.03), "cloth")  # loincloth top
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "skin")
        eye = v(c, (hx - 0.01, hy * 0.15, 0))
        b.sphere(eye, 0.115, "eyeWhite", segs=8, rings=5)  # one huge eye bulging out of the face
        b.sphere(v(eye, (0.07, 0, 0)), 0.065, "iris", segs=6, rings=4)
        b.sphere(v(eye, (0.11, 0, 0)), 0.035, "eye", segs=6, rings=4)
        b.box(v(c, (hx + 0.03, hy * 0.15 + 0.1, 0)), (0.12, 0.035, 0.24), "skinDark", rot=[0, 0, 10])  # heavy brow / lid
        b.cone(v(c, (hx * 0.3, hy + 0.06, 0)), 0.06, 0.012, 0.16, "horn", segs=6)  # horn nub
        b.box(v(c, (hx, -hy * 0.55, 0)), (0.03, 0.03, hz * 1.2), "eye")  # mouth
        for z in (-0.07, 0.07):
            b.spike(v(c, (hx, -hy * 0.55, z)), (0, 1, 0), 0.06, 0.022, "horn")  # tusks
        for sgn in (-1, 1):
            b.spike(v(c, (-hx * 0.4, hy * 0.2, sgn * hz * 0.85)), (-0.35, 0.85, sgn * 0.3), 0.18, 0.05, "skin")  # pointy ears
    elif name.startswith("foot"):
        b.collider(part, "skinDark")
        for z in (-s[2] * 0.3, 0.0, s[2] * 0.3):
            b.sphere(v(c, (s[0] / 2, -0.01, z)), 0.045, "skin", segs=6, rings=4)
    elif not plain_limb(b, part, {"upperArm": "skin", "lowerArm": "skin", "hand": "skin", "upperLeg": "skin", "lowerLeg": "skinDark"}):
        look_default(b, part, spec)


def look_mummy(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name in ("pelvis", "torso"):
        b.collider(part, "wrapA")
        b.slabs(part, "wrapB", 3 if name == "pelvis" else 6, height=0.035, start=0.1, end=0.9)
        if name == "torso":
            b.box(v(c, (s[0] / 2 + 0.005, 0.0, 0.02)), (0.02, s[1] * 0.9, 0.05), "wrapDark", rot=[0, 0, 0])  # loose diagonal wrap
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "wrapA")
        b.slabs(part, "wrapB", 3, height=0.035, start=0.1, end=0.9)
        b.box(v(c, (0.01, hy * 0.2, 0)), (hx * 2 + 0.02, 0.07, hz * 2 + 0.02), "gap")  # dark gap for the eyes
        b.eyes(c, hx * 0.35, hy * 0.2, hz + 0.01, 0.03, white=False, pupil_mat="glow")
        b.front_eyes(c, hx + 0.01, hy * 0.2, 0.055, 0.028, white_mat="glow", pupil_mat="glow")
        b.spike(v(c, (-hx * 0.2, hy, 0)), (-0.4, 0.5, 0.1), 0.1, 0.02, "wrapB", segs=4)  # loose bandage end
    elif name.startswith("hand"):
        b.collider(part, "wrapB")
        b.spike(v(c, (0.0, -s[0] * 0.5, 0)), (0.3, -1, 0), 0.08, 0.018, "wrapB", segs=4)  # trailing wrap
    elif name.startswith("foot"):
        b.collider(part, "wrapA")
        b.box(v(c, (s[0] * 0.2, 0, 0)), (0.03, s[1] + 0.012, s[2] + 0.012), "wrapB")
        b.box(v(c, (-s[0] * 0.2, 0, 0)), (0.03, s[1] + 0.012, s[2] + 0.012), "wrapB")
    else:
        mat = limb_material(name, {"upperArm": "wrapA", "lowerArm": "wrapA", "upperLeg": "wrapA", "lowerLeg": "wrapA"})
        if mat is None:
            return look_default(b, part, spec)
        b.collider(part, mat)
        b.bands(part, "wrapB", 3, width=0.03)


def look_yeti(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "fur", inflate=0.02)
    elif name == "torso":
        b.collider(part, "fur", inflate=0.025)
        b.box(v(c, (s[0] / 2 + 0.01, -0.05, 0)), (0.05, s[1] * 0.6, s[2] * 0.6), "furShade")  # belly patch
        for sgn in (-1, 1):
            for x in (-s[0] * 0.3, 0.0, s[0] * 0.3):
                b.spike(v(c, (x, s[1] / 2 + 0.02, sgn * s[2] * 0.4)), (-0.2, 1, sgn * 0.4), 0.09, 0.04, "fur")  # shaggy shoulders
        for x in (-s[0] * 0.35, -s[0] * 0.1, s[0] * 0.15, s[0] * 0.4):
            b.spike(v(c, (x, -s[1] / 2 - 0.02, 0)), (0, -1, 0), 0.1, 0.045, "fur")  # shaggy hem
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.collider(part, "fur", inflate=0.02)
        b.box(v(c, (hx + 0.01, -0.01, 0)), (0.04, hy * 1.2, hz * 1.5), "face")  # dark face patch, front
        for sgn in (-1, 1):
            b.box(v(c, (hx * 0.5, -0.01, sgn * (hz + 0.01))), (hx * 1.1, hy * 1.2, 0.04), "face")  # wraps the sides
        b.eyes(c, hx * 0.5, hy * 0.2, hz + 0.02, 0.028)
        b.front_eyes(c, hx + 0.02, hy * 0.2, 0.06, 0.025)
        b.sphere(v(c, (hx + 0.03, -hy * 0.15, 0)), 0.035, "nose", segs=6, rings=4)
        b.box(v(c, (hx + 0.03, -hy * 0.5, 0)), (0.015, 0.02, 0.12), "nose")  # mouth
        for z in (-0.04, 0.04):
            b.box(v(c, (hx + 0.03, -hy * 0.5 - 0.02, z)), (0.02, 0.035, 0.025), "teeth")  # fangs
        for (dx, dy, z) in ((-0.5, 1, 0), (0, 1, -0.4), (0, 1, 0.4), (0.4, 1, 0)):
            b.spike(v(c, (dx * 0.1, hy + 0.02, z * hz)), (dx, dy, z), 0.12, 0.045, "fur")  # tufts on top
    elif name.startswith("foot"):
        b.collider(part, "fur", inflate=0.015)
        for z in (-s[2] * 0.32, 0.0, s[2] * 0.32):
            b.sphere(v(c, (s[0] / 2 + 0.01, -0.01, z)), 0.045, "face", segs=6, rings=4)  # dark toes
    elif name.startswith("hand"):
        b.collider(part, "fur", inflate=0.02)
        b.sphere(v(c, (s[0] * 0.6, -s[0] * 0.4, 0)), s[0] * 0.6, "face", segs=6, rings=4)  # dark palm
    else:
        mat = limb_material(name, {"upperArm": "fur", "lowerArm": "fur", "upperLeg": "fur", "lowerLeg": "fur"})
        if mat is None:
            return look_default(b, part, spec)
        b.collider(part, mat, inflate=0.025)
        _, bottom = capsule_ends(part)
        for z in (-s[0] * 0.5, s[0] * 0.5):
            b.spike(v(bottom, (0.0, s[0] * 0.5, z)), (0.2, -1, 0), 0.08, 0.035, "furShade")  # shaggy fringe


def look_firelizard(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "scales")
        b.box(v(c, (0, -s[1] / 2 + 0.04, 0)), (s[0] - 0.05, 0.08, s[2] + 0.02), "belly")
        for x in (-0.1, 0.08):
            b.spike(v(c, (x, s[1] / 2 - 0.02, 0)), (-0.35, 1, 0), 0.16, 0.05, "spikes")  # spine spikes
    elif name == "chest":
        b.collider(part, "scales")
        b.box(v(c, (0, -s[1] / 2 + 0.04, 0)), (s[0] - 0.08, 0.08, s[2] + 0.02), "belly")
        for x in (-0.28, -0.08, 0.12, 0.3):
            b.spike(v(c, (x, s[1] / 2 - 0.02, 0)), (-0.35, 1, 0), 0.18, 0.055, "spikes")
        for sgn in (-1, 1):
            zz = sgn * (s[2] / 2 + 0.01)
            # stub wings: one fin rooted in the back, sweeping up and backwards, with a claw on the tip
            b.box(v(c, (-0.14, s[1] / 2 + 0.05, zz)), (0.42, 0.24, 0.02), "wing", rot=[sgn * 18, 0, -35])
            b.box(v(c, (-0.2, s[1] / 2 + 0.14, zz + sgn * 0.012)), (0.36, 0.045, 0.02), "wingBone", rot=[sgn * 18, 0, -35])
            b.spike(v(c, (-0.36, s[1] / 2 + 0.26, zz)), (-0.5, 0.85, 0), 0.07, 0.022, "spikes")  # wing claw
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        skull_len = hx * 1.1
        b.box(v(c, (-(hx * 2 - skull_len) / 2, 0.03, 0)), (skull_len, hy * 2 - 0.06, hz * 2), "scales")  # skull
        snout = v(c, (hx - skull_len * 0.45, -0.05, 0))
        b.box(snout, (skull_len * 0.95, hy * 1.2, hz * 1.6), "scales")
        b.box(v(snout, (0.0, -hy * 0.7, 0)), (skull_len * 0.9, 0.06, hz * 1.4), "scalesDark")  # lower jaw
        b.box(v(snout, (skull_len * 0.4, -hy * 0.55, 0)), (0.1, 0.02, 0.05), "tongue")
        for x in (-0.08, 0.02, 0.12):
            for sgn in (-1, 1):
                b.spike(v(snout, (x, -hy * 0.45, sgn * hz * 0.6)), (0, -1, 0), 0.05, 0.016, "spikes")  # teeth
        b.eyes(c, hx * 0.1, hy * 0.35, hz, 0.045, white_mat="eyeGlow")
        for sgn in (-1, 1):
            b.spike(v(c, (-hx * 0.7, hy * 0.6, sgn * hz * 0.6)), (-0.8, 0.6, sgn * 0.2), 0.2, 0.045, "spikes")  # back horns
        b.spike(v(c, (hx * 0.3, hy * 0.9, 0)), (-0.3, 1, 0), 0.12, 0.04, "spikes")  # crest
    elif name == "tail":
        b.collider(part, "scales")
        top, bottom = capsule_ends(part)
        for t in (0.2, 0.45, 0.7):
            p = top.lerp(bottom, t)
            b.spike(v(p, (0, s[0] * 0.8, 0)), (-0.3, 1, 0), 0.12, 0.04, "spikes")
        b.spike(v(bottom, (0.03, 0.02, 0)), (-1, -0.15, 0), 0.18, s[0] * 0.9, "scalesDark")  # tail tip
    elif name.startswith("upperLeg"):
        b.collider(part, "scales")
        top, _ = capsule_ends(part)
        b.sphere(v(top, (0, -0.03, 0)), s[0] * 1.5, "scales", scale=(1, 1.1, 0.9), segs=6, rings=4)  # thigh
    elif name.startswith("lowerLeg"):
        b.collider(part, "scalesDark")
        _, bottom = capsule_ends(part)
        b.sphere(v(bottom, (0.02, 0.02, 0)), s[0] * 1.2, "scalesDark", scale=(1.3, 0.7, 1), segs=6, rings=4)  # foot
        for z in (-0.04, 0.0, 0.04):
            b.spike(v(bottom, (s[0] * 0.9, 0.0, z)), (1, -0.2, 0), 0.06, 0.018, "spikes")  # claws
    else:
        look_default(b, part, spec)


# ----------------------------------------------------------------------------- space pack

def look_astronaut(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "suit", inflate=0.01)
        b.box(v(c, (0, s[1] / 2 - 0.03, 0)), (s[0] + 0.03, 0.05, s[2] + 0.03), "trim")  # belt
    elif name == "torso":
        b.collider(part, "suit", inflate=0.015)
        b.box(v(c, (s[0] / 2 + 0.01, s[1] * 0.15, 0)), (0.04, 0.1, s[2] * 0.6), "trim")  # chest control box
        for z in (-0.04, 0.0, 0.04):
            b.sphere(v(c, (s[0] / 2 + 0.03, s[1] * 0.15, z)), 0.015, "visor", segs=6, rings=4)  # buttons
        b.box(v(c, (-s[0] / 2 - 0.08, 0.0, 0)), (0.16, s[1] * 0.95, s[2] * 0.9), "pack")  # life-support backpack
        b.box(v(c, (-s[0] / 2 - 0.17, 0.0, 0)), (0.02, s[1] * 0.6, s[2] * 0.6), "packDark")
        for z in (-0.07, 0.07):
            b.box(v(c, (0, s[1] / 2 + 0.01, z)), (s[0] + 0.04, 0.04, 0.05), "packDark")  # straps
        b.box(v(c, (s[0] / 2 + 0.02, -s[1] * 0.2, s[2] * 0.25)), (0.012, 0.045, 0.065), "flagRed")  # flag patch, chest
        b.box(v(c, (s[0] / 2 + 0.025, -s[1] * 0.2 + 0.012, s[2] * 0.25 - 0.018)), (0.012, 0.02, 0.028), "flagBlue")
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        r = hx * 1.25
        b.sphere(c, r, "helmet", scale=(1.0, hy / hx * 1.12, hz / hx * 1.05))
        b.box(v(c, (r * 0.78, 0.01, 0)), (0.07, 0.15, hz * 1.5), "visor")  # gold visor, front
        for sgn in (-1, 1):
            b.box(v(c, (0.03, 0.01, sgn * (r * 0.92))), (hx * 1.5, 0.15, 0.03), "visor")  # wraps the sides
        b.eyes(c, hx * 0.35, 0.03, r * 0.92 + 0.01, 0.02, white=False, pupil_mat="trim")
        b.box(v(c, (r * 0.35, 0.01, 0)), (r, 0.02, hz * 2 + 0.06), "trim")  # visor rim
        b.box(v(c, (-r * 0.3, -hy * 1.0, 0)), (hx * 1.5, 0.06, hz * 2.2), "trim")  # neck ring
    elif name.startswith("upperArm"):
        b.collider(part, "suit", inflate=0.01)
        sgn = -1 if part.get("side") == "L" else 1
        zz = sgn * (s[0] + 0.012)
        b.box(v(c, (0, 0.02, zz)), (0.06, 0.045, 0.012), "flagRed")  # flag patch on the outer arm
        b.box(v(c, (-0.017, 0.032, zz + sgn * 0.004)), (0.026, 0.02, 0.012), "flagBlue")
    elif name.startswith("lowerArm") or name.startswith("upperLeg") or name.startswith("lowerLeg"):
        b.collider(part, "suit", inflate=0.01)
        b.bands(part, "suitShade", 2, inflate=0.012, width=0.025, start=0.3, end=0.7)  # puffy suit seams
        b.joint_knob(part, s[0] * 1.15, "trim", which="top")  # joint rings
    elif not plain_limb(b, part, {"hand": "suitShade", "foot": "trim"}, toe="trim"):
        look_default(b, part, spec)


def look_moonalien(b, part, spec):
    name, c, s = part["name"], part["pos"], part["size"]
    if name == "pelvis":
        b.collider(part, "suitDark")
    elif name == "torso":
        b.collider(part, "suit")
        b.box(v(c, (0, -s[1] / 2 + 0.02, 0)), (s[0] + 0.02, 0.03, s[2] + 0.02), "suitDark")  # belt
        b.sphere(v(c, (s[0] / 2, s[1] * 0.15, 0)), 0.03, "ball", segs=6, rings=4)  # chest gem
    elif name == "head":
        _, hx, hy, hz = head_dims(part)
        b.sphere(c, hx * 1.02, "skin", scale=(1.0, hy / hx * 1.02, hz / hx * 1.0))  # bulbous head
        b.sphere(v(c, (hx * 0.2, hy * 0.35, 0)), hx * 0.8, "skin", scale=(1.0, 0.9, 1.0), segs=8, rings=5)  # big cranium
        b.cone(v(c, (0, -hy * 0.95, 0)), 0.05, 0.06, hy * 0.5, "skin", segs=8)  # neck down to the collar
        b.eyes(c, hx * 0.5, 0.02, hz * 0.85, 0.05)  # outer two eyes read from the side
        b.sphere(v(c, (hx * 0.98, 0.06, 0)), 0.05, "eyeWhite", segs=6, rings=4)  # third eye, front centre
        b.sphere(v(c, (hx * 0.98 + 0.03, 0.06, 0)), 0.028, "iris", segs=6, rings=4)
        b.box(v(c, (hx * 0.95, -hy * 0.35, 0)), (0.02, 0.015, 0.08), "skinDark")  # little mouth
        for sgn in (-1, 1):
            base = v(c, (-hx * 0.15, hy * 0.85, sgn * hx * 0.3))
            d = Vector((-0.25, 1.0, sgn * 0.5)).normalized()
            b.capsule(Vector(base) + d * 0.09, 0.012, 0.16, "antenna", rot=dir_rot(d), segs=6)
            b.sphere(Vector(base) + d * 0.2, 0.04, "ball", segs=6, rings=4)  # antenna balls
    elif name.startswith("hand"):
        b.collider(part, "skin")
        for i in (-1, 1):
            b.spike(v(c, (0, -0.01, i * 0.02)), (0.3, -1, 0), 0.04, 0.01, "skin")  # long fingers
    elif not plain_limb(b, part, {"upperArm": "skin", "lowerArm": "skin", "upperLeg": "suit", "lowerLeg": "skin",
                                  "foot": "suitDark"}):
        look_default(b, part, spec)


LOOKS = {
    "knight": look_knight, "goblin": look_goblin, "wolf": look_wolf, "chicken": look_chicken,
    "farmer": look_farmer, "kid": look_kid, "giant": look_giant, "skeleton": look_skeleton, "slime": look_slime,
    "captainzap": look_captainzap, "rocketgirl": look_rocketgirl, "drskull": look_drskull, "robobrute": look_robobrute,
    "cyclops": look_cyclops, "mummy": look_mummy, "yeti": look_yeti, "firelizard": look_firelizard,
    "astronaut": look_astronaut, "moonalien": look_moonalien,
}


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
