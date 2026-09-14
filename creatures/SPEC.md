# Creature spec contract

One JSON file per creature in `creatures/specs/<id>.json`. The SAME file drives:

1. **Runtime ragdoll** (game, TypeScript): every `part` becomes one Rapier rigid body +
   collider, joined to its parent by a revolute (hinge) joint around the Z axis.
2. **Blender generation** (`tools/build_creatures.py`): every `part` becomes one bone in an
   armature and one chunk of mesh rigidly skinned (weight 1.0) to that bone. Exported as
   `public/models/<id>.glb`.

## Coordinate system

- glTF / Three.js convention: **+Y up, +X right, +Z toward the camera**. Units are meters.
- The creature stands on the ground plane `y = 0`, feet at `y ~ 0`, centered around `x = 0`.
- The creature **faces +X** in rest pose (side-scroller; the game mirrors it to face -X).
- Blender is Z-up. Build in Blender coordinates `(bx, by, bz) = (x, -z, y)` and export with the
  glTF exporter default `+Y up` so positions round-trip exactly.
- The game locks all motion to the XY plane (Z translation and X/Y rotation are locked), so
  small fixed Z offsets on left/right limbs are purely visual and are preserved.

## Fields

```jsonc
{
  "id": "knight",            // file name, model name, unique
  "name": "Knight",          // shown in the UI
  "faction": "human",
  "enemies": ["goblin", "wolf"],   // creature ids it will fight on sight
  "hp": 100,
  "walkSpeed": 1.6,          // m/s
  "grip": "hand.R",          // part that holds items/weapons
  "eyeHeight": 1.6,          // for line-of-sight raycasts
  "standHeight": 0.95,       // rest height of the root part center above ground (balance spring)
  "root": "pelvis",          // the part with no parent
  "palette": { "skin": "#e8b88a", "armor": "#9aa4b1" },  // hints for Blender materials
  "faction": "human",        // human | hero | villain | monster | giant | wildlife | farm | alien
  "enemyFactions": ["monster", "villain"],  // fights any creature whose faction is listed
  "pack": "heroes",          // omit for the base game; otherwise the code pack that unlocks it
  "icon": "🛡️",              // emoji for the UI card
  "blurb": "Brave and shiny", // one short line for the UI card
  "parts": [ { ...part }, ... ]
}
```

Enemy matrix (keep it symmetric-ish): human <-> monster, villain, alien, wildlife;
hero <-> villain, monster, alien, giant; villain <-> hero, human; monster <-> human, hero, farm;
giant <-> everyone except giant; alien <-> human, hero; wildlife (wolf) <-> farm, human;
farm (chicken) <-> monster, wildlife. `enemies` (explicit ids) still works on top of factions.

### Part

```jsonc
{
  "name": "upperArm.L",       // unique within creature; bone name in the GLB must match EXACTLY
  "parent": "torso",          // null for the root
  "shape": "capsule",         // "box" | "capsule" | "sphere"
  "pos": [x, y, z],           // world-space center of the collider in rest pose
  "rot": [rx, ry, rz],        // optional, degrees, Euler XYZ, rest rotation of the collider (default [0,0,0])
  "size": [...],              // box: [width x, height y, depth z]
                              // capsule: [radius, cylinderLength] with the axis along local +Y
                              // sphere: [radius]
  "mass": 4,                  // kg
  "side": "L",                // optional "L" | "R" - used for visual z-offset and mirroring
  "joint": {                  // required for every non-root part
    "anchor": [x, y, z],      // world-space hinge point shared with the parent, rest pose
    "limits": [minDeg, maxDeg],  // rotation about +Z relative to rest; positive = counter-clockwise
                                 // when viewed from +Z (i.e. from the front of the screen)
    "stiffness": 60,          // optional motor stiffness for pose holding (default 40)
    "damping": 4              // optional motor damping (default 3)
  },
  "role": "head"              // optional semantic tag: head | torso | pelvis | arm | hand | leg | foot | tail | wing
}
```

## Rules the GLB must satisfy (the runtime depends on these)

- One armature, one skinned mesh (or several meshes, all skinned to the same armature).
- A bone per part, **named exactly `part.name`**. Bone parenting must follow `part.parent`.
- Every vertex of the chunk that belongs to a part has weight **1.0** on that part's bone and 0
  on all other bones (rigid skinning). No smooth blending across parts.
- In rest/bind pose the mesh must line up with the colliders described by the spec
  (same positions and sizes in the Y-up glTF frame). Bone head/tail placement is free: the
  runtime computes the bone offset relative to the part at load time.
- Mesh geometry may be more detailed than the collider (ears, eyes, snout, helmet plume,
  fingers) as long as the visual mass stays roughly inside the collider.
- Low-poly, flat colors via materials (vertex colors also fine). No textures needed.
- Export with `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', export_yup=True,
  export_apply=True, export_skins=True, export_animations=False)`.

## Design guidance for authoring specs

- Bipeds: pelvis (root) -> torso -> head; torso -> upperArm.L/R -> lowerArm.L/R -> hand.L/R;
  pelvis -> upperLeg.L/R -> lowerLeg.L/R -> foot.L/R. Left limbs at z = -0.06, right at z = +0.06.
- Quadrupeds: pelvis (root, rear) -> chest -> head; legs hang from chest (front) and pelvis (rear);
  optional tail.
- Elbows only bend one way (`[0, 140]`), knees only the other way (`[-130, 0]`).
- Keep total part count between 8 and 16.
- Masses should sum to something sensible (human ~ 60 kg, chicken ~ 2 kg, wolf ~ 35 kg).
