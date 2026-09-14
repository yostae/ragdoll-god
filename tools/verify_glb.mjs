#!/usr/bin/env node
// Verifies public/models/<id>.glb against creatures/specs/<id>.json (no dependencies).
//   node tools/verify_glb.mjs [ids...]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPEC_DIR = join(ROOT, "creatures", "specs");
const MODEL_DIR = join(ROOT, "public", "models");
const BBOX_TOLERANCE = 0.25; // fraction of the spec extent per axis
const BBOX_FLOOR = 0.04; // meters, so tiny axes (chicken z) are not over-strict

// ------------------------------------------------------------------ GLB parsing

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("bad GLB magic");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

const COMP = {
  5120: { size: 1, read: (dv, o) => dv.getInt8(o), norm: 127 },
  5121: { size: 1, read: (dv, o) => dv.getUint8(o), norm: 255 },
  5122: { size: 2, read: (dv, o) => dv.getInt16(o, true), norm: 32767 },
  5123: { size: 2, read: (dv, o) => dv.getUint16(o, true), norm: 65535 },
  5125: { size: 4, read: (dv, o) => dv.getUint32(o, true), norm: 1 },
  5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true), norm: 1 },
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const n = NCOMP[acc.type];
  const comp = COMP[acc.componentType];
  const out = [];
  if (acc.bufferView === undefined) {
    for (let i = 0; i < acc.count; i++) out.push(new Array(n).fill(0));
    return out;
  }
  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? comp.size * n;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    for (let k = 0; k < n; k++) {
      let val = comp.read(dv, base + i * stride + k * comp.size);
      if (acc.normalized) val /= comp.norm;
      row.push(val);
    }
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ math helpers

function quatToMat(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}
function mul(a, b) {
  // column-major 4x4: (a*b)[col j][row i]
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return r;
}
function nodeLocal(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const m = quatToMat(r);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 3; i++) m[c * 4 + i] *= s[c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}
function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
// Rotation angle (degrees) and axis of the upper-left 3x3 of a column-major matrix.
function matRot(m) {
  const trace = m[0] + m[5] + m[10];
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * (180 / Math.PI);
  if (angle < 0.01) return "identity";
  const ax = [m[6] - m[9], m[8] - m[2], m[1] - m[4]];
  const n = Math.hypot(...ax) || 1;
  return `${angle.toFixed(1)}deg about [${ax.map((v) => (v / n).toFixed(2)).join(",")}]`;
}
const f3 = (v) => `[${v.map((x) => (x >= 0 ? " " : "") + x.toFixed(3)).join(", ")}]`;

// ------------------------------------------------------------------ spec geometry

function rotMatrix(rotDegs) {
  if (!rotDegs) return null;
  const [rx, ry, rz] = rotDegs.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // Euler XYZ (Blender/mathutils convention): R = Rz * Ry * Rx
  return [
    [cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz],
    [cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz],
    [-sy, cy * sx, cx * cy],
  ];
}
function rotate(R, v) {
  if (!R) return v;
  return [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
}
function partBounds(p) {
  const c = p.pos;
  const R = rotMatrix(p.rot);
  const pts = [];
  const signs = [-1, 1];
  if (p.shape === "box") {
    const h = p.size.map((s) => s / 2);
    for (const sx of signs) for (const sy of signs) for (const sz of signs)
      pts.push(rotate(R, [sx * h[0], sy * h[1], sz * h[2]]).map((v, i) => v + c[i]));
  } else if (p.shape === "sphere") {
    for (const sx of signs) for (const sy of signs) for (const sz of signs)
      pts.push([c[0] + sx * p.size[0], c[1] + sy * p.size[0], c[2] + sz * p.size[0]]);
  } else if (p.shape === "capsule") {
    const [r, len] = p.size;
    const axis = rotate(R, [0, len / 2, 0]);
    for (const e of [1, -1]) {
      const end = c.map((v, i) => v + e * axis[i]);
      for (const sx of signs) for (const sy of signs) for (const sz of signs)
        pts.push([end[0] + sx * r, end[1] + sy * r, end[2] + sz * r]);
    }
  } else {
    throw new Error(`unknown shape ${p.shape}`);
  }
  return bboxOf(pts);
}
function bboxOf(pts) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  return { lo, hi };
}
function unionBox(a, b) {
  return { lo: a.lo.map((v, i) => Math.min(v, b.lo[i])), hi: a.hi.map((v, i) => Math.max(v, b.hi[i])) };
}

// Sanity checks on the spec itself: joint anchors should sit on the parent/child boundary.
function checkSpecGeometry(spec, log) {
  const byName = new Map(spec.parts.map((p) => [p.name, p]));
  let ok = true;
  for (const p of spec.parts) {
    if (!p.parent) continue;
    const parent = byName.get(p.parent);
    if (!parent) { log(`  spec: ${p.name} has unknown parent ${p.parent}`); ok = false; continue; }
    const a = p.joint?.anchor;
    if (!a) { log(`  spec: ${p.name} has no joint.anchor`); ok = false; continue; }
    const dc = distToShape(a, p);
    const dp = distToShape(a, parent);
    if (dc > 0.03 || dp > 0.03)
      log(`  spec: anchor of ${p.name} is ${dc.toFixed(3)} m from its own collider, ${dp.toFixed(3)} m from parent ${p.parent}`);
  }
  return ok;
}
// Distance from a point to the surface (or 0 if inside) of a collider; approximate for rotated boxes.
function distToShape(pt, p) {
  const c = p.pos;
  const R = rotMatrix(p.rot);
  // bring the point into the part's local frame (R^T * (pt - c))
  let d = pt.map((v, i) => v - c[i]);
  if (R) d = [0, 1, 2].map((i) => R[0][i] * d[0] + R[1][i] * d[1] + R[2][i] * d[2]);
  if (p.shape === "sphere") return Math.max(0, Math.hypot(...d) - p.size[0]);
  if (p.shape === "box") {
    const q = d.map((v, i) => Math.abs(v) - p.size[i] / 2);
    return Math.hypot(...q.map((v) => Math.max(v, 0)));
  }
  const [r, len] = p.size;
  const y = Math.max(-len / 2, Math.min(len / 2, d[1]));
  return Math.max(0, Math.hypot(d[0], d[1] - y, d[2]) - r);
}

// ------------------------------------------------------------------ verification

function verify(spec) {
  const lines = [];
  const problems = [];
  const log = (s) => lines.push(s);
  const fail = (s) => { problems.push(s); lines.push(`  FAIL: ${s}`); };

  const glbPath = join(MODEL_DIR, `${spec.id}.glb`);
  if (!existsSync(glbPath)) { fail(`missing ${glbPath}`); return { lines, problems }; }
  const { json: gltf, bin } = parseGlb(readFileSync(glbPath));

  checkSpecGeometry(spec, log);

  // 1. exactly one skin
  const skins = gltf.skins ?? [];
  if (skins.length !== 1) fail(`expected exactly 1 skin, found ${skins.length}`);
  const skin = skins[0];
  if (!skin) return { lines, problems };

  // world matrices for every node
  const nodes = gltf.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const world = new Array(nodes.length);
  const worldOf = (i) => {
    if (world[i]) return world[i];
    const local = nodeLocal(nodes[i]);
    const p = parentOf.get(i);
    world[i] = p === undefined ? local : mul(worldOf(p), local);
    return world[i];
  };

  // 2. every part is a joint node; 3. parenting matches
  const jointNodes = new Map();
  for (const j of skin.joints) jointNodes.set(nodes[j].name, j);
  const partNames = new Set(spec.parts.map((p) => p.name));
  for (const name of jointNodes.keys())
    if (!partNames.has(name)) log(`  note: extra joint '${name}' not in spec`);
  for (const p of spec.parts) {
    const j = jointNodes.get(p.name);
    if (j === undefined) { fail(`part '${p.name}' has no joint node`); continue; }
    const parentIdx = parentOf.get(j);
    const parentName = parentIdx === undefined ? null : nodes[parentIdx].name;
    if (p.parent) {
      if (parentName !== p.parent) fail(`'${p.name}' parent is '${parentName}', spec says '${p.parent}'`);
    } else if (parentIdx !== undefined && jointNodes.has(parentName)) {
      fail(`root '${p.name}' is parented to joint '${parentName}'`);
    }
  }

  // bone rest translations vs spec positions
  log("  bone rest translation (glTF world)      spec pos                   drift   world rest rotation");
  let maxDrift = 0;
  for (const p of spec.parts) {
    const j = jointNodes.get(p.name);
    if (j === undefined) continue;
    const m = worldOf(j);
    const t = [m[12], m[13], m[14]];
    const drift = Math.hypot(...t.map((v, i) => v - p.pos[i]));
    maxDrift = Math.max(maxDrift, drift);
    log(`  ${p.name.padEnd(12)} ${f3(t)}  ${f3(p.pos)}  ${drift.toFixed(4)}  ${matRot(m)}`);
  }
  if (maxDrift > 0.005) fail(`bone rest positions drift up to ${maxDrift.toFixed(4)} m from spec`);

  // 4. rigid skinning + 5. bounds
  const jointOrder = skin.joints; // JOINTS_0 indexes into this list
  const partByJointName = new Map(spec.parts.map((p) => [p.name, p]));
  let meshCount = 0;
  let skinnedNodes = 0;
  let totalVerts = 0;
  let totalTris = 0;
  let badWeights = 0;
  let farVerts = 0;
  const allPts = [];
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.mesh === undefined) continue;
    meshCount++;
    if (n.skin === undefined) { fail(`mesh node '${n.name}' is not skinned`); continue; }
    if (n.skin !== 0) fail(`mesh node '${n.name}' uses skin ${n.skin}`);
    skinnedNodes++;
    const mesh = gltf.meshes[n.mesh];
    for (const prim of mesh.primitives) {
      const pos = readAccessor(gltf, bin, prim.attributes.POSITION);
      totalVerts += pos.length;
      if (prim.indices !== undefined) totalTris += gltf.accessors[prim.indices].count / 3;
      else totalTris += pos.length / 3;
      const J = prim.attributes.JOINTS_0, W = prim.attributes.WEIGHTS_0;
      if (J === undefined || W === undefined) { fail(`primitive in '${n.name}' lacks JOINTS_0/WEIGHTS_0`); continue; }
      const joints = readAccessor(gltf, bin, J);
      const weights = readAccessor(gltf, bin, W);
      for (let vi = 0; vi < pos.length; vi++) {
        const w = weights[vi];
        const ones = w.filter((x) => Math.abs(x - 1) < 1e-3).length;
        const zeros = w.filter((x) => Math.abs(x) < 1e-3).length;
        if (ones !== 1 || zeros !== 3) { badWeights++; continue; }
        const slot = w.findIndex((x) => Math.abs(x - 1) < 1e-3);
        const jointNode = jointOrder[joints[vi][slot]];
        const part = partByJointName.get(nodes[jointNode]?.name);
        if (!part) { badWeights++; continue; }
        // skinned vertices are in armature space; skin.skeleton/armature node at identity
        const wp = pos[vi];
        allPts.push(wp);
        const b = partBounds(part);
        const slack = 0.25;
        if (wp.some((v, i) => v < b.lo[i] - slack || v > b.hi[i] + slack)) farVerts++;
      }
    }
  }
  if (meshCount === 0) fail("no mesh nodes");
  if (badWeights) fail(`${badWeights} vertices are not rigidly skinned (one weight of 1.0)`);
  if (farVerts) log(`  note: ${farVerts} vertices lie > 0.25 m outside their part's collider box`);
  log(`  meshes: ${meshCount} (skinned: ${skinnedNodes}), verts: ${totalVerts}, tris: ${totalTris}`);
  if (totalTris > 3000) fail(`${totalTris} tris exceeds 3000 budget`);

  if (allPts.length) {
    const mb = bboxOf(allPts);
    const sb = spec.parts.map(partBounds).reduce(unionBox);
    const axes = ["x", "y", "z"];
    for (let i = 0; i < 3; i++) {
      const extent = sb.hi[i] - sb.lo[i];
      const tol = Math.max(BBOX_FLOOR, extent * BBOX_TOLERANCE);
      const dLo = mb.lo[i] - sb.lo[i];
      const dHi = mb.hi[i] - sb.hi[i];
      const status = Math.abs(dLo) > tol || Math.abs(dHi) > tol ? "FAIL" : "ok";
      log(`  bbox ${axes[i]}: mesh [${mb.lo[i].toFixed(3)}, ${mb.hi[i].toFixed(3)}]  spec [${sb.lo[i].toFixed(3)}, ${sb.hi[i].toFixed(3)}]  dlo ${dLo.toFixed(3)} dhi ${dHi.toFixed(3)} (tol ${tol.toFixed(3)}) ${status}`);
      if (status === "FAIL") fail(`bounding box on ${axes[i]} differs from spec by more than ${(BBOX_TOLERANCE * 100).toFixed(0)}%`);
    }
  }
  return { lines, problems };
}

// ------------------------------------------------------------------ main

const wanted = process.argv.slice(2);
const specFiles = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).sort();
let failures = 0;
for (const f of specFiles) {
  const id = basename(f, ".json");
  if (wanted.length && !wanted.includes(id)) continue;
  const spec = JSON.parse(readFileSync(join(SPEC_DIR, f), "utf8"));
  let result;
  try {
    result = verify(spec);
  } catch (e) {
    result = { lines: [`  error: ${e.message}`], problems: [e.message] };
  }
  const status = result.problems.length ? "FAIL" : "PASS";
  if (result.problems.length) failures++;
  console.log(`\n== ${id}: ${status}`);
  for (const l of result.lines) console.log(l);
}
console.log(`\n${failures ? `${failures} creature(s) FAILED` : "all creatures PASS"}`);
process.exit(failures ? 1 : 0);
