"""Generate the 15 new creature specs (and patch the 4 existing ones) for sandbox-ragdoll-game.

Bipeds share one chain layout derived from the knight's proportions, scaled to the target
height with per-creature multipliers; the torso height absorbs the residual so the top of the
head lands exactly at H. Anchors are placed on/inside both colliders they join.
"""
import json
import os

ROOT = r"C:\Users\yosta\claudeshack\sandbox-ragdoll-game"
SPEC_DIR = os.path.join(ROOT, "creatures", "specs")

ENEMY = {
    "human": ["monster", "villain", "alien", "wildlife"],
    "hero": ["villain", "monster", "alien", "giant"],
    "villain": ["hero", "human"],
    "monster": ["human", "hero", "farm"],
    "giant": ["human", "hero", "villain", "monster", "alien", "wildlife", "farm"],
    "alien": ["human", "hero"],
    "wildlife": ["farm", "human"],
    "farm": ["monster", "wildlife"],
}


def r3(x):
    return round(x + 0.0, 3) + 0.0


def rv(v):
    return [r3(a) for a in v]


# knight mass fractions (sum 59 kg)
MASS_FRAC = {"pelvis": 8, "torso": 14, "head": 5, "upperArm": 2.5, "lowerArm": 1.5, "hand": 0.5,
             "upperLeg": 6, "lowerLeg": 4, "foot": 1.5}
MASS_TOTAL_REF = 8 + 14 + 5 + 2 * (2.5 + 1.5 + 0.5 + 6 + 4 + 1.5)


def biped(cid, name, H, faction, hp, walk, icon, blurb, palette, total_mass, pack=None, enemies=None,
          head=None, head_shape="box", torso_w=1.0, torso_d=1.0, pelvis_w=1.0, arm_r=1.0, arm_len=1.0,
          leg_r=1.0, leg_len=1.0, foot_scale=1.0, hand_r=None, hand_shape="sphere", hand_box=None,
          mass_override=None, zoff=None):
    s = H / 1.76
    z = zoff if zoff is not None else r3(0.06 * s)
    head_sz = head or [0.26 * s, 0.28 * s, 0.26 * s]
    if head_shape == "sphere":
        head_h = head_sz[0] * 2
    else:
        head_h = head_sz[1]
    torso_wd = 0.36 * s * torso_w
    torso_dp = 0.22 * s * torso_d
    pelvis_sz = [0.32 * s * pelvis_w, 0.20 * s, 0.20 * s]
    ua = [0.06 * s * arm_r, 0.16 * s * arm_len]
    la = [0.055 * s * arm_r, 0.16 * s * arm_len]
    hr = hand_r if hand_r is not None else 0.055 * s * max(1.0, arm_r * 0.9)
    ul = [0.075 * s * leg_r, 0.25 * s * leg_len]
    ll = [0.065 * s * leg_r, 0.25 * s * leg_len]
    foot = [0.22 * s * foot_scale, 0.09 * s, 0.14 * s * foot_scale]

    # ---- vertical chain (bottom-up)
    fh = foot[1]
    ankle = fh + 0.01
    ll_c = ankle + ll[0] + ll[1] / 2
    knee = ankle + 2 * ll[0] + ll[1]
    ul_c = knee + ul[0] + ul[1] / 2
    hip = knee + 2 * ul[0] + ul[1]
    pelvis_bottom = hip - 0.03
    pelvis_c = pelvis_bottom + pelvis_sz[1] / 2
    pelvis_top = pelvis_bottom + pelvis_sz[1]
    head_bottom = H - head_h
    neck = head_bottom - 0.01
    torso_top = neck - 0.02
    torso_h = torso_top - pelvis_top
    assert torso_h > 0.12 * s, f"{cid}: torso too short ({torso_h:.3f})"
    torso_c = pelvis_top + torso_h / 2
    head_c = head_bottom + head_h / 2
    torso_sz = [torso_wd, torso_h, torso_dp]

    # ---- arms
    shoulder_y = torso_top - 0.03 * s
    arm_x = torso_wd / 2 + ua[0] - 0.02
    anchor_x = torso_wd / 2 + 0.005
    # the hinge sits just outside the torso face, inside the upper arm's top cap (not at its tip)
    shoulder_anchor_y = shoulder_y - ua[0] * 0.6
    ua_c = shoulder_y - ua[0] - ua[1] / 2
    elbow = shoulder_y - 2 * ua[0] - ua[1]
    la_c = elbow - la[0] - la[1] / 2
    wrist = elbow - 2 * la[0] - la[1]
    if hand_shape == "sphere":
        hand_c = wrist - hr + 0.005
    else:
        hand_c = wrist - hand_box[1] / 2 + 0.005

    # ---- legs
    leg_x = pelvis_sz[0] / 2 - ul[0] + 0.005
    foot_dx = foot[0] * 0.18

    mass_scale = total_mass / MASS_TOTAL_REF
    ov = mass_override or {}

    def m(role_key):
        return round(ov.get(role_key, MASS_FRAC[role_key] * mass_scale), 2)

    parts = []
    parts.append({"name": "pelvis", "parent": None, "shape": "box", "pos": rv([0, pelvis_c, 0]), "size": rv(pelvis_sz),
                  "mass": m("pelvis"), "role": "pelvis"})
    parts.append({"name": "torso", "parent": "pelvis", "shape": "box", "pos": rv([0, torso_c, 0]), "size": rv(torso_sz),
                  "mass": m("torso"), "role": "torso",
                  "joint": {"anchor": rv([0, pelvis_top, 0]), "limits": [-20, 20], "stiffness": 80, "damping": 6}})
    head_part = {"name": "head", "parent": "torso", "shape": head_shape, "pos": rv([0, head_c, 0]),
                 "size": rv(head_sz if head_shape == "box" else [head_sz[0]]), "mass": m("head"), "role": "head",
                 "joint": {"anchor": rv([0, neck, 0]), "limits": [-30, 30], "stiffness": 30, "damping": 3}}
    parts.append(head_part)
    for side, sgn in (("L", -1), ("R", 1)):
        zz = sgn * z
        parts.append({"name": f"upperArm.{side}", "parent": "torso", "shape": "capsule", "pos": rv([sgn * arm_x, ua_c, zz]),
                      "size": rv(ua), "mass": m("upperArm"), "side": side, "role": "arm",
                      "joint": {"anchor": rv([sgn * anchor_x, shoulder_anchor_y, zz]), "limits": [-160, 60]}})
        parts.append({"name": f"lowerArm.{side}", "parent": f"upperArm.{side}", "shape": "capsule", "pos": rv([sgn * arm_x, la_c, zz]),
                      "size": rv(la), "mass": m("lowerArm"), "side": side, "role": "arm",
                      "joint": {"anchor": rv([sgn * arm_x, elbow, zz]), "limits": [0, 140]}})
        hp_ = {"name": f"hand.{side}", "parent": f"lowerArm.{side}", "shape": hand_shape, "pos": rv([sgn * arm_x, hand_c, zz]),
               "size": rv([hr]) if hand_shape == "sphere" else rv(hand_box), "mass": m("hand"), "side": side, "role": "hand",
               "joint": {"anchor": rv([sgn * arm_x, wrist, zz]), "limits": [-30, 30]}}
        parts.append(hp_)
    for side, sgn in (("L", -1), ("R", 1)):
        zz = sgn * z
        parts.append({"name": f"upperLeg.{side}", "parent": "pelvis", "shape": "capsule", "pos": rv([sgn * leg_x, ul_c, zz]),
                      "size": rv(ul), "mass": m("upperLeg"), "side": side, "role": "leg",
                      "joint": {"anchor": rv([sgn * leg_x, hip, zz]), "limits": [-90, 60], "stiffness": 70, "damping": 5}})
        parts.append({"name": f"lowerLeg.{side}", "parent": f"upperLeg.{side}", "shape": "capsule", "pos": rv([sgn * leg_x, ll_c, zz]),
                      "size": rv(ll), "mass": m("lowerLeg"), "side": side, "role": "leg",
                      "joint": {"anchor": rv([sgn * leg_x, knee, zz]), "limits": [-130, 0], "stiffness": 60, "damping": 5}})
        parts.append({"name": f"foot.{side}", "parent": f"lowerLeg.{side}", "shape": "box", "pos": rv([sgn * leg_x + foot_dx, fh / 2, zz]),
                      "size": rv(foot), "mass": m("foot"), "side": side, "role": "foot",
                      "joint": {"anchor": rv([sgn * leg_x, ankle, zz]), "limits": [-30, 30]}})

    spec = {
        "id": cid, "name": name, "faction": faction, "enemyFactions": ENEMY[faction], "enemies": enemies or [],
        "hp": hp, "walkSpeed": walk, "grip": "hand.R", "eyeHeight": r3(head_c + head_h * 0.1),
        "standHeight": r3(pelvis_c), "root": "pelvis", "icon": icon, "blurb": blurb, "palette": palette, "parts": parts,
    }
    if pack:
        spec["pack"] = pack
    return spec


def slime():
    body_c = [0, 0.36, 0]
    parts = [
        {"name": "body", "parent": None, "shape": "sphere", "pos": body_c, "size": [0.3], "mass": 12, "role": "body"},
        {"name": "head", "parent": "body", "shape": "sphere", "pos": [0.04, 0.63, 0], "size": [0.14], "mass": 3, "role": "head",
         "joint": {"anchor": [0.03, 0.55, 0], "limits": [-25, 25], "stiffness": 30, "damping": 3}},
        {"name": "nub.L", "parent": "body", "shape": "capsule", "pos": [0.31, 0.38, -0.07], "rot": [0, 0, -90], "size": [0.04, 0.08],
         "mass": 0.4, "side": "L", "role": "arm",
         "joint": {"anchor": [0.26, 0.38, -0.07], "limits": [-60, 60], "stiffness": 20, "damping": 2}},
        {"name": "nub.R", "parent": "body", "shape": "capsule", "pos": [0.31, 0.38, 0.07], "rot": [0, 0, -90], "size": [0.04, 0.08],
         "mass": 0.4, "side": "R", "role": "arm",
         "joint": {"anchor": [0.26, 0.38, 0.07], "limits": [-60, 60], "stiffness": 20, "damping": 2}},
        {"name": "upperLeg.L", "parent": "body", "shape": "capsule", "pos": [-0.1, 0.07, -0.06], "size": [0.045, 0.05], "mass": 1,
         "side": "L", "role": "leg",
         "joint": {"anchor": [-0.1, 0.12, -0.06], "limits": [-60, 60], "stiffness": 50, "damping": 4}},
        {"name": "upperLeg.R", "parent": "body", "shape": "capsule", "pos": [0.1, 0.07, 0.06], "size": [0.045, 0.05], "mass": 1,
         "side": "R", "role": "leg",
         "joint": {"anchor": [0.1, 0.12, 0.06], "limits": [-60, 60], "stiffness": 50, "damping": 4}},
    ]
    return {
        "id": "slime", "name": "Slime", "faction": "monster", "enemyFactions": ENEMY["monster"], "enemies": [],
        "hp": 40, "walkSpeed": 1.3, "grip": "nub.R", "eyeHeight": 0.66, "standHeight": 0.36, "root": "body",
        "icon": "\U0001F7E2", "blurb": "Bouncy, gooey and always hungry",
        "palette": {"goo": "#8fe07a", "gooDark": "#5cb548", "gooLight": "#c6f5b5", "mouth": "#3b7a2c"},
        "parts": parts,
    }


def firelizard():
    k = 1.4
    parts = [
        {"name": "pelvis", "parent": None, "shape": "box", "pos": [-0.49, 0.84, 0], "size": [0.45, 0.39, 0.34], "mass": 30, "role": "pelvis"},
        {"name": "chest", "parent": "pelvis", "shape": "box", "pos": [0.14, 0.87, 0], "size": [0.81, 0.45, 0.39], "mass": 40, "role": "torso",
         "joint": {"anchor": [-0.27, 0.85, 0], "limits": [-15, 15], "stiffness": 120, "damping": 9}},
        {"name": "head", "parent": "chest", "shape": "box", "pos": [0.78, 1.0, 0], "size": [0.48, 0.34, 0.31], "mass": 13, "role": "head",
         "joint": {"anchor": [0.55, 0.98, 0], "limits": [-40, 30], "stiffness": 50, "damping": 5}},
        {"name": "tail", "parent": "pelvis", "shape": "capsule", "pos": [-1.055, 0.719, 0], "rot": [0, 0, 100], "size": [0.07, 0.6], "mass": 5, "role": "tail",
         "joint": {"anchor": [-0.71, 0.78, 0], "limits": [-45, 45], "stiffness": 20, "damping": 3}},
    ]
    for tag, x, parent in (("F", 0.39, "chest"), ("B", -0.53, "pelvis")):
        for side, sgn in (("L", -1), ("R", 1)):
            zz = sgn * 0.11
            lower_limits = [-120, 0] if tag == "F" else [0, 120]
            parts.append({"name": f"upperLeg.{tag}{side}", "parent": parent, "shape": "capsule", "pos": [x, 0.483, zz], "size": [0.077, 0.168],
                          "mass": 5, "side": side, "role": "leg",
                          "joint": {"anchor": [x, 0.644, zz], "limits": [-60, 60], "stiffness": 70, "damping": 6}})
            parts.append({"name": f"lowerLeg.{tag}{side}", "parent": f"upperLeg.{tag}{side}", "shape": "capsule", "pos": [x, 0.161, zz], "size": [0.063, 0.196],
                          "mass": 3, "side": side, "role": "leg",
                          "joint": {"anchor": [x, 0.322, zz], "limits": lower_limits, "stiffness": 60, "damping": 5}})
    return {
        "id": "firelizard", "name": "Fire Lizard", "faction": "monster", "enemyFactions": ENEMY["monster"], "enemies": [],
        "hp": 120, "walkSpeed": 2.6, "grip": "head", "eyeHeight": 1.05, "standHeight": 0.84, "root": "pelvis", "pack": "monsters",
        "icon": "\U0001F432", "blurb": "Hot-headed, spiky and fast",
        "palette": {"scales": "#d9442b", "scalesDark": "#8f2a18", "belly": "#f2a541", "spikes": "#ffd166", "wing": "#5e1a10",
                    "wingBone": "#f2a541", "eyeGlow": "#ffe45c", "tongue": "#ff6b6b"},
        "parts": parts,
    }


SPECS = [
    # ---- base
    biped("farmer", "Farmer", 1.75, "human", 90, 1.5, "\U0001F468\u200D\U0001F33E", "Salt of the earth, handy with a pitchfork",
          {"skin": "#e8b88a", "overalls": "#3b62b5", "overallsDark": "#2b4a8e", "shirt": "#c8392b", "hat": "#d9b45a",
           "hatDark": "#b08f3e", "beard": "#5a3a22", "boots": "#4a3320"}, 70),
    biped("kid", "Kid", 1.15, "human", 50, 2.4, "\U0001F9D2", "Small, fast and full of mischief",
          {"skin": "#f0c8a0", "shirt": "#f4f4f4", "stripe": "#d83a3a", "shorts": "#3a5fbf", "cap": "#2e9e4f", "capDark": "#1f6e37",
           "hair": "#5a3a22", "sneaker": "#ffffff", "sneakerSole": "#e2483d"}, 30,
          head=[0.3, 0.3, 0.3], leg_len=0.8, arm_len=0.85, torso_w=1.05),
    biped("giant", "Giant", 3.8, "giant", 400, 1.1, "\U0001F5FF", "Enormous, grumpy and very heavy",
          {"skin": "#d9a781", "skinDark": "#b8865f", "tunic": "#7a6a4a", "tunicDark": "#5a4d33", "brow": "#3a2a1a", "boots": "#4a3a2a"}, 450,
          arm_r=1.3, leg_r=1.3, torso_w=1.15, pelvis_w=1.15, foot_scale=1.1, hand_r=0.18,
          mass_override={"hand": 8, "pelvis": 60, "torso": 110, "head": 35}),
    biped("skeleton", "Skeleton", 1.7, "monster", 60, 1.7, "\U0001F480", "Rattles, clatters, never gives up",
          {"bone": "#f2ede0", "boneDark": "#c9c0aa", "socket": "#1a1a1a", "ribs": "#e0d9c4"}, 28,
          arm_r=0.6, leg_r=0.65, torso_d=0.9, hand_r=0.045),
    slime(),
    # ---- heroes (affectionate comic-book parodies: archetype silhouettes and colours, no real logos or names)
    biped("captainzap", "Ultra Guy", 1.85, "hero", 160, 2.4, "🦸", "Faster than a speeding chicken",
          {"suit": "#2456c9", "suitDark": "#17398a", "cape": "#d62c2c", "boots": "#d62c2c", "belt": "#ffd91f", "hair": "#161616",
           "skin": "#e8b88a", "emblemRed": "#d62c2c", "emblemYellow": "#ffd91f"}, 85, pack="heroes", torso_w=1.08),
    biped("rocketgirl", "Wonder Gal", 1.65, "hero", 140, 2.5, "⭐", "Bracelets deflect everything",
          {"top": "#d8322b", "shorts": "#2456c9", "star": "#ffffff", "gold": "#ffcc33", "hair": "#161616", "skin": "#e8b88a",
           "boots": "#d8322b", "lips": "#c0272d"}, 60, pack="heroes"),
    biped("drskull", "Jester Jack", 1.8, "villain", 100, 1.8, "🃏", "Thinks everything is a joke",
          {"jacket": "#6a2a9a", "jacketDark": "#4a1c6e", "shirt": "#3ec24a", "face": "#f4f4f4", "hair": "#2fbf4f", "grin": "#d62c2c",
           "makeup": "#1c1c1c", "flower": "#ff8c1a", "stem": "#2f7d32", "gloves": "#f4f4f4", "shoes": "#1c1c1c"}, 70, pack="heroes"),
    biped("robobrute", "Robo-Brute", 2.4, "villain", 220, 1.0, "🤖", "Crushing things is its whole job",
          {"metal": "#8c9097", "metalDark": "#4f545c", "metalLight": "#b9bec6", "eyeRed": "#ff2020", "rubber": "#2a2a2a"}, 250,
          pack="heroes", head=[0.36 * 1.364, 0.26 * 1.364, 0.34 * 1.364], torso_w=1.25, torso_d=1.2, pelvis_w=1.1, arm_r=1.25, leg_r=1.25,
          hand_shape="box", hand_box=[0.19, 0.2, 0.14], foot_scale=1.1,
          mass_override={"hand": 6, "torso": 90, "pelvis": 45}),
    biped("nightmoth", "Night Moth", 1.9, "hero", 150, 2.2, "🦇", "Broods on rooftops",
          {"suit": "#4a4f57", "suitDark": "#33373d", "cape": "#141414", "cowl": "#141414", "belt": "#ffd91f", "emblem": "#ffd91f",
           "moth": "#141414", "skin": "#e8b88a", "eyeSlit": "#ffffff"}, 90, pack="heroes", torso_w=1.08),
    biped("webkid", "Web Kid", 1.7, "hero", 120, 2.8, "🕸️", "Sticks to things",
          {"red": "#d8322b", "blue": "#2456c9", "web": "#3a0f0f", "eyeRim": "#141414", "lens": "#ffffff"}, 60, pack="heroes",
          arm_r=0.9, leg_r=0.9),
    biped("greengrump", "Green Grump", 2.5, "hero", 260, 1.4, "💚", "Gets angrier when bonked",
          {"skin": "#4fa84a", "skinDark": "#3a7d36", "shorts": "#6a2a9a", "shortsDark": "#4a1c6e", "hair": "#161616", "brow": "#161616",
           "teeth": "#ffffff", "mouth": "#2a1a1a"}, 230, pack="heroes", arm_r=1.5, leg_r=1.35, torso_w=1.3, torso_d=1.2, pelvis_w=1.2,
          hand_r=0.11, mass_override={"hand": 6, "torso": 70, "pelvis": 32}),
    biped("magnetman", "Magnet Man", 1.85, "villain", 130, 1.6, "🧲", "Very attached to metal things",
          {"armor": "#c0272d", "armorDark": "#8a1a1f", "purple": "#6a2a9a", "purpleDark": "#4a1c6e", "cape": "#6a2a9a", "helmet": "#c0272d",
           "skin": "#e8b88a", "trim": "#ffcc33"}, 85, pack="heroes"),
    # ---- monsters
    biped("cyclops", "Cyclops", 2.6, "monster", 220, 1.2, "\U0001F441\uFE0F", "One eye, one bad mood",
          {"skin": "#8b5cc4", "skinDark": "#5e3a8c", "cloth": "#8a6a3a", "clothDark": "#5e4726", "horn": "#e8dcc0", "eyeWhite": "#f8f8f8",
           "iris": "#e0a020"}, 200, pack="monsters", arm_r=1.15, leg_r=1.15, torso_w=1.1, head=[0.42, 0.44, 0.42],
          mass_override={"head": 22}),
    biped("mummy", "Mummy", 1.7, "monster", 90, 0.9, "\U0001F9DF", "Slow, wrapped up and glowing at you",
          {"wrapA": "#d9c9a3", "wrapB": "#b9a780", "wrapDark": "#8a7a58", "glow": "#7dff5a", "gap": "#3b2f20"}, 55, pack="monsters"),
    biped("yeti", "Yeti", 2.2, "monster", 180, 1.5, "\u2744\uFE0F", "Big, shaggy and surprisingly quick",
          {"fur": "#f2f4f7", "furShade": "#cfd6e0", "face": "#4a5361", "eye": "#141414", "nose": "#2a2a2a", "teeth": "#ffffff"}, 180,
          pack="monsters", arm_r=1.25, leg_r=1.2, torso_w=1.2, torso_d=1.15, pelvis_w=1.1, foot_scale=1.4, head=[0.32, 0.3, 0.3]),
    firelizard(),
    # ---- space
    biped("astronaut", "Astronaut", 1.8, "human", 110, 1.4, "\U0001F469\u200D\U0001F680", "One small step, one big bounce",
          {"suit": "#f4f4f4", "suitShade": "#d0d4da", "visor": "#e8b42a", "helmet": "#f4f4f4", "pack": "#c9ced6", "packDark": "#7a808a",
           "flagRed": "#d62c2c", "flagBlue": "#2456c9", "trim": "#3a3f47"}, 90, pack="space", arm_r=1.3, leg_r=1.25, torso_w=1.15,
          torso_d=1.15, head=[0.28, 0.3, 0.28], hand_r=0.07),
    biped("moonalien", "Moon Alien", 1.4, "alien", 80, 2.0, "\U0001F47D", "Three eyes see everything, twice",
          {"skin": "#6fdc6f", "skinDark": "#3f9e3f", "suit": "#8c8cff", "suitDark": "#5c5cc0", "antenna": "#3f9e3f", "ball": "#ff4fa0",
           "eyeWhite": "#f8f8f8", "iris": "#141414"}, 45, pack="space", head=[0.4, 0.4, 0.4], arm_r=0.6, leg_r=0.6, leg_len=0.9,
          torso_w=0.9, hand_r=0.04, mass_override={"head": 8}),
]

KEY_ORDER = ["id", "name", "faction", "enemyFactions", "enemies", "pack", "hp", "walkSpeed", "grip", "eyeHeight", "standHeight",
             "root", "icon", "blurb", "palette", "parts"]
PART_ORDER = ["name", "parent", "shape", "pos", "rot", "size", "mass", "side", "role", "joint"]


def fmt_part(p):
    items = [(k, p[k]) for k in PART_ORDER if k in p]
    return "    { " + ", ".join(f"{json.dumps(k)}: {json.dumps(val, ensure_ascii=False)}" for k, val in items) + " }"


def fmt_spec(spec):
    lines = ["{"]
    for k in KEY_ORDER:
        if k not in spec:
            continue
        if k == "parts":
            lines.append('  "parts": [')
            lines.append(",\n".join(fmt_part(p) for p in spec["parts"]))
            lines.append("  ]")
        else:
            lines.append(f"  {json.dumps(k)}: {json.dumps(spec[k], ensure_ascii=False)},")
    lines.append("}")
    return "\n".join(lines) + "\n"


def check(spec):
    total = sum(p["mass"] for p in spec["parts"])
    by = {p["name"]: p for p in spec["parts"]}
    lo = min(p["pos"][1] - (p["size"][1] / 2 if p["shape"] == "box" else p["size"][0] + (p["size"][1] / 2 if p["shape"] == "capsule" and not p.get("rot") else 0)) for p in spec["parts"])
    hi = max(p["pos"][1] + (p["size"][1] / 2 if p["shape"] == "box" else p["size"][0] + (p["size"][1] / 2 if p["shape"] == "capsule" and not p.get("rot") else 0)) for p in spec["parts"])
    print(f"{spec['id']:<12} parts={len(spec['parts']):>2} mass={total:7.1f} y=[{lo:.3f},{hi:.3f}] stand={spec['standHeight']} eye={spec['eyeHeight']}")
    if not 8 <= len(spec["parts"]) <= 16:
        print(f"  note: {spec['id']} has {len(spec['parts'])} parts (outside the 8-16 guideline)")
    for p in spec["parts"]:
        if p["parent"]:
            assert p["parent"] in by, p


if __name__ == "__main__":
    import sys
    only = set(sys.argv[1:])  # optional: ids to (re)write; default all
    for spec in SPECS:
        if only and spec["id"] not in only:
            continue
        check(spec)
        with open(os.path.join(SPEC_DIR, f"{spec['id']}.json"), "w", encoding="utf-8") as f:
            f.write(fmt_spec(spec))
    print("done")
