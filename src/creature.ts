import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics, PlaneLock } from './physics';
import type { CreatureSpec, PartSpec } from './types';
import { cloneModel, loadCreatureModel } from './models';
import type { Item } from './item';
import type { Effects } from './effects';

export type BrainState = 'upright' | 'ko' | 'gettingUp' | 'held';

const DEG = Math.PI / 180;
const ROLE_SUPPORT = new Set(['pelvis', 'torso', 'body']);

/** Balance / locomotion tuning. Exposed on window.TUNE so it can be adjusted live in the console. */
export const TUNE = {
  hoverK: 55, // spring toward rest height (1/s^2)
  hoverD: 9, // vertical damping (1/s)
  hoverOffset: 0.03, // extra clearance above rest height (m)
  walkHover: 0.0, // extra clearance while walking (m)
  walkGain: 6, // horizontal velocity tracking gain (1/s)
  uprightK: 80,
  uprightD: 12,
  torqueBoost: 3, // extra multiplier on part inertia, since limbs hang off the supports
  motorK: 6, // multiplier on spec joint stiffness
  motorD: 2, // multiplier on spec joint damping
  gaitAmp: 0.45, // upper-leg swing amplitude (rad)
  gaitSpeed: 7.5, // rad/s
  kneeBend: 1.2,
  legStiffWalk: 1.0, // leg motor stiffness multiplier while walking
};
(window as unknown as { TUNE: typeof TUNE }).TUNE = TUNE;

interface Part {
  spec: PartSpec;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  joint: RAPIER.RevoluteImpulseJoint | null;
  parent: Part | null;
  restAngle: number; // radians, child rz - parent rz
  restY: number; // rest center height above the feet, unscaled
  restRot: THREE.Quaternion; // rest rotation (facing +1)
  poseTarget: number; // desired joint angle relative to rest, radians
  stiffness: number;
  damping: number;
}

interface BoneBinding {
  bone: THREE.Bone;
  offset: THREE.Matrix4;
  parentPart: string | null;
  part: string;
}

let nextId = 1;

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const Y180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/** A creature = an active ragdoll (one hinge-jointed rigid body per part) + a skinned mesh + a tiny brain. */
export class Creature {
  id = nextId++;
  spec: CreatureSpec;
  scale: number;
  facing: 1 | -1;
  tint?: string;
  parts: Part[] = [];
  partByName = new Map<string, Part>();
  root!: Part;
  supports: Part[] = [];
  totalMass = 0;
  container = new THREE.Group();
  private bones: BoneBinding[] = [];
  private fallbackMeshes = new Map<string, THREE.Mesh>();
  private modelRoot: THREE.Object3D | null = null;
  private planeLocks: PlaneLock[] = [];
  disposed = false;

  // brain
  state: BrainState = 'upright';
  hp: number;
  maxHp: number;
  stateTimer = 0;
  strength = 1; // 0..1 ramp for getting up
  moveDir = 0;
  wanderTimer = 0;
  thinkTimer = 0;
  target: Creature | null = null;
  attackCooldown = 0;
  attackTime = -1; // -1 = not attacking
  struck = false; // this swing already landed
  gaitPhase = 0;
  turnCooldown = 0;
  heldItem: Item | null = null;
  grabbed = false;
  dizzy: THREE.Group | null = null;
  gravityScale = 1;
  floatTimer = 0;
  hurtFlash = 0;
  invuln = 0; // seconds of immunity after getting up
  time = 0;
  headMod = 1;

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
    private effects: Effects,
    spec: CreatureSpec,
    x: number,
    y: number,
    facing: 1 | -1 = 1,
    scale = 1,
    tint?: string,
    headMod = 1,
  ) {
    this.spec = spec;
    this.scale = scale;
    this.facing = facing;
    this.tint = tint;
    this.headMod = headMod;
    this.hp = this.maxHp = spec.hp;
    this.scene.add(this.container);
    this.build(x, y);
    this.setState('upright');
    this.buildFallbackMeshes();
    loadCreatureModel(spec.id).then((model) => {
      if (this.disposed || !model) return;
      this.attachModel(model);
    });
  }

  // ---------- construction ----------

  private partSize(p: PartSpec): number[] {
    const s = this.scale * (p.role === 'head' ? this.headMod : 1);
    return p.size.map((v) => v * s);
  }

  private build(x: number, y: number) {
    const s = this.scale;
    const q0 = this.facing === 1 ? new THREE.Quaternion() : Y180.clone();
    const order = this.topoOrder();
    for (const ps of order) {
      const rest = new THREE.Vector3(ps.pos[0] * s, ps.pos[1] * s, ps.pos[2] * s);
      const world = rest.clone().applyQuaternion(q0).add(new THREE.Vector3(x, y, 0));
      const rz = (ps.rot?.[2] ?? 0) * DEG;
      const restRot = new THREE.Quaternion().setFromEuler(new THREE.Euler((ps.rot?.[0] ?? 0) * DEG, (ps.rot?.[1] ?? 0) * DEG, rz));
      const q = q0.clone().multiply(restRot);

      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(world.x, world.y, world.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.15)
        .setAngularDamping(1.0)
        .setCcdEnabled(true);
      const body = this.physics.world.createRigidBody(desc);

      const size = this.partSize(ps);
      let cd: RAPIER.ColliderDesc;
      if (ps.shape === 'box') cd = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
      else if (ps.shape === 'capsule') cd = RAPIER.ColliderDesc.capsule(size[1] / 2, size[0]);
      else cd = RAPIER.ColliderDesc.ball(size[0]);
      const mass = ps.mass * s * s * s * (ps.role === 'head' ? this.headMod : 1);
      cd.setMass(mass)
        .setFriction(0.7)
        .setRestitution(0.05)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = this.physics.world.createCollider(cd, body);
      this.totalMass += mass;
      this.physics.register(body, { kind: 'creature', id: this.id, part: ps.name, soft: ps.role === 'leg' || ps.role === 'foot' });

      const parent = ps.parent ? this.partByName.get(ps.parent)! : null;
      let joint: RAPIER.RevoluteImpulseJoint | null = null;
      let restAngle = 0;
      const part: Part = {
        spec: ps,
        body,
        collider,
        joint: null,
        parent,
        restAngle: 0,
        restY: ps.pos[1],
        restRot,
        poseTarget: 0,
        stiffness: ps.joint?.stiffness ?? 40,
        damping: ps.joint?.damping ?? 3,
      };
      if (parent && ps.joint) {
        const anchorWorld = new THREE.Vector3(ps.joint.anchor[0] * s, ps.joint.anchor[1] * s, ps.joint.anchor[2] * s).applyQuaternion(q0).add(new THREE.Vector3(x, y, 0));
        const pt = parent.body.translation();
        const pr = parent.body.rotation();
        const pq = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w);
        const a1 = anchorWorld.clone().sub(new THREE.Vector3(pt.x, pt.y, pt.z)).applyQuaternion(pq.clone().invert());
        const a2 = anchorWorld.clone().sub(world).applyQuaternion(q.clone().invert());
        const jd = RAPIER.JointData.revolute({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z }, { x: 0, y: 0, z: 1 });
        joint = this.physics.world.createImpulseJoint(jd, parent.body, body, true) as RAPIER.RevoluteImpulseJoint;
        const prz = (parent.spec.rot?.[2] ?? 0) * DEG;
        restAngle = rz - prz;
        joint.setLimits(restAngle + ps.joint.limits[0] * DEG, restAngle + ps.joint.limits[1] * DEG);
        joint.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
        part.joint = joint;
        part.restAngle = restAngle;
      }
      this.parts.push(part);
      this.partByName.set(ps.name, part);
      if (!parent) this.root = part;
      // Every part gets its own plane lock: hinge chains alone drift out of the plane under contact.
      this.planeLocks.push(this.physics.createPlaneLock(body, { x: q0.x, y: q0.y, z: q0.z, w: q0.w }));
      if (ps.role && ROLE_SUPPORT.has(ps.role)) this.supports.push(part);
    }
    if (this.supports.length === 0) this.supports.push(this.root);
    this.applyMotors();
  }

  private topoOrder(): PartSpec[] {
    const out: PartSpec[] = [];
    const seen = new Set<string>();
    const byName = new Map(this.spec.parts.map((p) => [p.name, p]));
    const visit = (p: PartSpec) => {
      if (seen.has(p.name)) return;
      if (p.parent) {
        const par = byName.get(p.parent);
        if (par) visit(par);
      }
      seen.add(p.name);
      out.push(p);
    };
    this.spec.parts.forEach(visit);
    return out;
  }

  private buildFallbackMeshes() {
    const palette = Object.values(this.spec.palette ?? {});
    const primary = palette[0] ?? '#cccccc';
    const secondary = palette[1] ?? '#888888';
    const tertiary = palette[2] ?? secondary;
    for (const part of this.parts) {
      const size = this.partSize(part.spec);
      let geo: THREE.BufferGeometry;
      if (part.spec.shape === 'box') geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
      else if (part.spec.shape === 'capsule') geo = new THREE.CapsuleGeometry(size[0], size[1], 2, 8);
      else geo = new THREE.SphereGeometry(size[0], 8, 6);
      const role = part.spec.role;
      const color = role === 'head' || role === 'hand' ? primary : role === 'leg' || role === 'foot' ? tertiary : secondary;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.container.add(mesh);
      this.fallbackMeshes.set(part.spec.name, mesh);
    }
    this.applyTint();
  }

  private attachModel(src: THREE.Group) {
    const model = cloneModel(src);
    this.modelRoot = model;
    // Bind pose: model at origin facing +X, unscaled, exactly the spec rest pose.
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const bindings: BoneBinding[] = [];
    for (const part of this.parts) {
      const bone = model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(part.spec.name)) as THREE.Bone | undefined;
      if (!bone || !(bone as THREE.Bone).isBone) continue;
      const restWorld = new THREE.Matrix4().compose(new THREE.Vector3(...part.spec.pos), part.restRot, new THREE.Vector3(1, 1, 1));
      const offset = restWorld.clone().invert().multiply(bone.matrixWorld);
      let parentPart: string | null = null;
      if (bone.parent && (bone.parent as THREE.Bone).isBone) {
        const pp = this.parts.find((p) => THREE.PropertyBinding.sanitizeNodeName(p.spec.name) === bone.parent!.name);
        if (pp) parentPart = pp.spec.name;
      }
      bone.matrixAutoUpdate = false;
      bindings.push({ bone, offset, parentPart, part: part.spec.name });
    }
    if (bindings.length < this.parts.length * 0.5) {
      console.warn(`Model for ${this.spec.id} is missing bones; keeping fallback meshes.`);
      return;
    }
    for (const mesh of this.fallbackMeshes.values()) {
      this.container.remove(mesh);
      mesh.geometry.dispose();
    }
    this.fallbackMeshes.clear();
    this.bones = bindings;
    this.container.add(model);
    this.applyTint();
    this.syncVisuals();
  }

  private applyTint() {
    if (!this.tint) return;
    const c = new THREE.Color(this.tint);
    this.container.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (sm.color) sm.color.lerp(c, 0.55);
      }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.heldItem) this.dropItem();
    for (const part of this.parts) {
      if (part.joint) this.physics.world.removeImpulseJoint(part.joint, true);
    }
    for (const lock of this.planeLocks) this.physics.removePlaneLock(lock);
    this.planeLocks = [];
    for (const part of this.parts) this.physics.removeBody(part.body);
    this.scene.remove(this.container);
    this.container.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    if (this.dizzy) this.effects.removeDizzy(this.dizzy);
  }

  // ---------- queries ----------

  get position(): THREE.Vector3 {
    const t = this.root.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** Position of the feet (root minus stand height). */
  get feetY() {
    return this.root.body.translation().y - this.spec.standHeight * this.scale;
  }

  get head(): Part {
    return this.parts.find((p) => p.spec.role === 'head') ?? this.root;
  }

  get gripPart(): Part {
    return this.partByName.get(this.spec.grip) ?? this.root;
  }

  isEnemyOf(other: Creature) {
    return this.spec.enemies.includes(other.spec.id);
  }

  bodies(): RAPIER.RigidBody[] {
    return this.parts.map((p) => p.body);
  }

  velocity(): THREE.Vector3 {
    const v = this.root.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  // ---------- control ----------

  private applyMotors() {
    const active = this.state === 'upright' || this.state === 'gettingUp';
    const k = active ? this.strength : 0;
    for (const part of this.parts) {
      if (!part.joint) continue;
      const stiff = part.stiffness * TUNE.motorK * k;
      const damp = part.damping * TUNE.motorD * k + 0.5;
      part.joint.configureMotorPosition(part.restAngle + part.poseTarget, stiff, damp);
    }
  }

  setState(s: BrainState, timer = 0) {
    this.state = s;
    this.stateTimer = timer;
    // While balancing, legs are cosmetic: the creature hovers on its balance springs, so the legs
    // must not kick the ground (that launched creatures and pole-vaulted them over their feet).
    const legsSolid = !(s === 'upright' || s === 'gettingUp');
    for (const p of this.parts) {
      if (p.spec.role === 'leg' || p.spec.role === 'foot') p.collider.setSensor(!legsSolid);
    }
    if (s === 'gettingUp') this.invuln = timer + 0.8;
    if (s === 'gettingUp') this.strength = 0;
    if (s === 'upright') this.strength = 1;
    if (s === 'ko' || s === 'held') {
      this.strength = 0;
      this.attackTime = -1;
      this.moveDir = 0;
    }
    if (s === 'ko') {
      if (!this.dizzy) this.dizzy = this.effects.makeDizzy();
    } else if (this.dizzy) {
      this.effects.removeDizzy(this.dizzy);
      this.dizzy = null;
    }
    this.applyMotors();
  }

  hurt(amount: number, fromX?: number) {
    if (amount <= 0 || this.invuln > 0 || this.state === 'gettingUp') return;
    this.hp -= amount;
    this.hurtFlash = 0.25;
    if (this.hp <= 0 && this.state !== 'ko') {
      this.hp = 0;
      this.knockOut(5 + Math.random() * 3);
      const h = this.head.body.translation();
      this.effects.word(h.x, h.y + 0.3, 'K.O.!', '#ff6b6b');
      if (fromX !== undefined) {
        const dir = Math.sign(this.root.body.translation().x - fromX) || 1;
        for (const p of this.supports) p.body.applyImpulse({ x: dir * this.totalMass * 1.5, y: this.totalMass * 2.5, z: 0 }, true);
      }
    }
  }

  knockOut(seconds: number) {
    if (this.heldItem) this.dropItem();
    this.setState('ko', seconds);
  }

  /** Called by the God's hand tool. */
  setGrabbed(g: boolean) {
    this.grabbed = g;
    if (g) this.setState('held');
    else {
      const v = this.velocity();
      if (this.hp <= 0) this.setState('ko', 3);
      else if (v.length() > 5) this.setState('ko', 1.2);
      else this.setState('gettingUp', 1.0);
    }
  }

  /** Rigidly rotate the whole assembly 180 degrees around the vertical axis through the root. */
  turn() {
    const r = this.root.body.translation();
    const rot = (b: RAPIER.RigidBody) => {
      const t = b.translation();
      const q = b.rotation();
      const nq = Y180.clone().multiply(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      b.setTranslation({ x: 2 * r.x - t.x, y: t.y, z: -t.z }, true);
      b.setRotation({ x: nq.x, y: nq.y, z: nq.z, w: nq.w }, true);
      const v = b.linvel();
      b.setLinvel({ x: -v.x, y: v.y, z: v.z }, true);
      const w = b.angvel();
      b.setAngvel({ x: 0, y: 0, z: -w.z }, true);
    };
    for (const p of this.parts) rot(p.body);
    if (this.heldItem) rot(this.heldItem.body);
    this.facing = this.facing === 1 ? -1 : 1;
    const q0 = this.facing === 1 ? new THREE.Quaternion() : Y180.clone();
    this.planeLocks.forEach((lock, i) => this.physics.setPlaneLockRotation(lock, { x: q0.x, y: q0.y, z: q0.z, w: q0.w }, this.parts[i].body));
    this.turnCooldown = 0.6;
  }

  holdItem(item: Item) {
    if (this.heldItem) this.dropItem();
    item.attachTo(this);
    this.heldItem = item;
  }

  dropItem() {
    if (!this.heldItem) return;
    this.heldItem.detach();
    this.heldItem = null;
  }

  startAttack() {
    if (this.attackTime >= 0 || this.state !== 'upright') return;
    this.attackTime = 0;
    this.struck = false;
    this.attackCooldown = 1.1 + Math.random() * 0.5;
  }

  /** True while the striking part is sweeping through its arc. */
  inStrikeWindow(): boolean {
    if (this.attackTime < 0 || this.struck) return false;
    const t = this.attackTime;
    return this.gripPart.spec.role === 'hand' ? t >= 0.26 && t <= 0.6 : t >= 0.22 && t <= 0.55;
  }

  /** The body doing the hitting: a held item if there is one, else the grip part. */
  strikerBody(): RAPIER.RigidBody {
    return this.heldItem ? this.heldItem.body : this.gripPart.body;
  }

  /** Physics-rate control: balance springs, walking, posture motors, attacks. */
  controlStep(dt: number) {
    this.time += dt;
    // Rapier keeps user forces between steps, so clear last step's balance forces first.
    for (const p of this.parts) {
      p.body.resetForces(false);
      p.body.resetTorques(false);
    }
    if (this.floatTimer > 0) {
      this.floatTimer -= dt;
      if (this.floatTimer <= 0) this.setGravityScale(1);
    }
    if (this.state === 'ko' || this.state === 'held') {
      if (this.state === 'ko') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0 && !this.grabbed) {
          this.hp = this.maxHp;
          this.setState('gettingUp', 1.2);
        }
      }
      return;
    }
    if (this.state === 'gettingUp') {
      this.stateTimer -= dt;
      this.strength = Math.min(1, this.strength + dt / 1.0);
      if (this.stateTimer <= 0) this.setState('upright');
      this.applyMotors();
    }
    const k = this.strength;
    const g = -this.physics.world.gravity.y * this.gravityScale;
    const s = this.scale;
    const speedWanted = this.moveDir * this.spec.walkSpeed * Math.sqrt(s);
    const share = 1 / this.supports.length;

    // Balance: each support part hovers at its rest height above whatever ground is below it.
    for (const part of this.supports) {
      const t = part.body.translation();
      const v = part.body.linvel();
      const groundY = this.physics.groundBelow(t.x, t.y, 4 * s + 1, this.id);
      let fy = 0;
      if (groundY !== null) {
        const targetY = groundY + part.restY * s + TUNE.hoverOffset + (Math.abs(speedWanted) > 0.1 ? TUNE.walkHover : 0);
        const err = targetY - t.y;
        if (err > -1.5 * s) {
          fy = this.totalMass * (g + TUNE.hoverK * err - TUNE.hoverD * v.y) * share * k;
          fy = THREE.MathUtils.clamp(fy, -this.totalMass * g * 0.5, this.totalMass * g * 3);
        }
      }
      const fx = this.totalMass * (speedWanted - v.x) * TUNE.walkGain * share * k;
      part.body.addForce({ x: fx, y: fy, z: 0 }, true);
      // Upright torque from the tilt of the local up vector.
      const q = part.body.rotation();
      _q.set(q.x, q.y, q.z, q.w);
      _p.set(0, 1, 0).applyQuaternion(_q);
      const w = part.body.angvel();
      // Scale by this part's own inertia: the joints and motors drag the rest of the body along.
      // (Scaling by whole-body inertia over-drives a small pelvis and launches the creature.)
      const inertia = Math.max(part.body.principalInertia().z, 1e-4) * (1 + TUNE.torqueBoost);
      // A CCW lean puts the up vector x negative, so +K*up.x is the restoring direction.
      let torque = inertia * (TUNE.uprightK * _p.x - TUNE.uprightD * w.z) * k;
      const maxT = inertia * TUNE.uprightK * 1.2;
      torque = THREE.MathUtils.clamp(torque, -maxT, maxT);
      part.body.addTorque({ x: 0, y: 0, z: torque }, true);
    }

    // Gait: swing legs while moving, hold rest pose otherwise.
    const moving = Math.abs(speedWanted) > 0.1;
    this.gaitPhase += dt * (moving ? TUNE.gaitSpeed : 3);
    const amp = moving ? TUNE.gaitAmp : 0.03;
    let legIndex = 0;
    for (const part of this.parts) {
      const role = part.spec.role;
      if (role === 'leg' && part.parent && ROLE_SUPPORT.has(part.parent.spec.role ?? '')) {
        // Upper leg: alternate legs by index.
        const ph = this.gaitPhase + (legIndex % 2) * Math.PI + (legIndex >= 2 ? Math.PI / 2 : 0);
        part.poseTarget = Math.sin(ph) * amp * (this.moveDir >= 0 ? 1 : -1) * (this.moveDir === 0 ? 1 : 1);
        legIndex++;
      } else if (role === 'leg' && part.parent && part.parent.spec.role === 'leg') {
        // Lower leg follows its upper leg: bend when the upper leg swings forward.
        const up = part.parent.poseTarget;
        const lim = part.spec.joint?.limits ?? [-90, 0];
        const bendDir = lim[0] < 0 && lim[1] <= 0 ? -1 : 1;
        part.poseTarget = bendDir * Math.max(0, up * TUNE.kneeBend) * (moving ? 1 : 0.2);
      } else if (role === 'arm' && part.parent && ROLE_SUPPORT.has(part.parent.spec.role ?? '')) {
        part.poseTarget = moving ? Math.sin(this.gaitPhase + Math.PI) * 0.4 : Math.sin(this.time * 2) * 0.05;
      } else if (role === 'arm') {
        part.poseTarget = 0.35;
      } else if (role === 'wing') {
        part.poseTarget = moving ? Math.sin(this.gaitPhase * 2) * 0.5 : 0;
      } else if (role === 'tail') {
        part.poseTarget = Math.sin(this.time * 6) * 0.3;
      } else if (role === 'head') {
        part.poseTarget = 0;
      }
    }

    // Attack: wind up, strike, recover. Arms do a big overhead swing; head-grip creatures lunge.
    if (this.attackTime >= 0) {
      this.attackTime += dt;
      const t = this.attackTime;
      const grip = this.gripPart;
      if (grip.spec.role === 'hand') {
        // Walk up the chain: hand -> lowerArm -> upperArm.
        const lower = grip.parent;
        const upper = lower?.parent;
        if (t < 0.28) {
          if (upper) upper.poseTarget = -2.6;
          if (lower) lower.poseTarget = 1.2;
        } else if (t < 0.5) {
          // Aim well past the joint limit so the hand sweeps through the target at full speed.
          if (upper) upper.poseTarget = 2.2;
          if (lower) lower.poseTarget = 0.0;
          if (t - dt < 0.28) {
            // Extra shove so the swing carries real momentum.
            const dir = this.facing;
            grip.body.applyImpulse({ x: dir * this.totalMass * 0.12 * s, y: -this.totalMass * 0.05, z: 0 }, true);
            if (this.heldItem) this.heldItem.body.applyImpulse({ x: dir * this.heldItem.def.mass * 4, y: -this.heldItem.def.mass * 2, z: 0 }, true);
          }
        } else if (t < 0.9) {
          if (upper) upper.poseTarget = 0.2;
        } else {
          this.attackTime = -1;
        }
      } else {
        // Lunge / peck / bite.
        const head = this.head;
        if (t < 0.25) head.poseTarget = 0.5;
        else if (t < 0.45) {
          head.poseTarget = -0.5;
          if (t - dt < 0.25) {
            for (const p of this.supports) p.body.applyImpulse({ x: this.facing * this.totalMass * 2.2 * share, y: this.totalMass * 1.4 * share, z: 0 }, true);
          }
        } else if (t < 0.8) head.poseTarget = 0;
        else this.attackTime = -1;
      }
    }

    // Motors only need re-configuring when targets change; they change every step while active.
    for (const part of this.parts) {
      if (!part.joint) continue;
      let boost = this.attackTime >= 0 && (part.spec.role === 'arm' || part.spec.role === 'head') ? 2.5 : 1;
      if (moving && (part.spec.role === 'leg' || part.spec.role === 'foot')) boost *= TUNE.legStiffWalk;
      part.joint.configureMotorPosition(part.restAngle + part.poseTarget, part.stiffness * TUNE.motorK * k * boost, part.damping * TUNE.motorD * k + 0.5);
    }
  }

  /** Slow-rate decision making. */
  think(dt: number, creatures: Creature[]) {
    this.attackCooldown -= dt;
    this.turnCooldown -= dt;
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.thinkTimer -= dt;
    if (this.thinkTimer > 0) return;
    this.thinkTimer = 0.15;
    if (this.state !== 'upright') {
      this.moveDir = 0;
      return;
    }
    const me = this.root.body.translation();
    const eye = { x: me.x, y: this.feetY + this.spec.eyeHeight * this.scale };

    // Find the nearest visible enemy.
    let best: Creature | null = null;
    let bestD = 14 * Math.sqrt(this.scale);
    for (const other of creatures) {
      if (other === this || other.disposed || !this.isEnemyOf(other)) continue;
      const ot = other.root.body.translation();
      const d = Math.hypot(ot.x - me.x, ot.y - me.y);
      if (d >= bestD) continue;
      if (!this.physics.lineOfSight(eye.x, eye.y, ot.x, ot.y)) continue;
      best = other;
      bestD = d;
    }
    this.target = best;

    if (best) {
      const ot = best.root.body.translation();
      const dx = ot.x - me.x;
      const dir = (Math.sign(dx) || 1) as 1 | -1;
      if (dir !== this.facing && this.turnCooldown <= 0) this.turn();
      const reach = (0.5 + (this.heldItem ? 0.4 : 0)) * this.scale + 0.3 * best.scale;
      if (Math.abs(dx) > reach) {
        this.moveDir = this.cliffAhead(dir) ? 0 : dir;
      } else {
        this.moveDir = 0;
        if (this.attackCooldown <= 0 && best.state !== 'ko') this.startAttack();
        else if (best.state === 'ko' && this.attackCooldown <= 0 && Math.random() < 0.3) this.startAttack();
      }
      return;
    }

    // Wander.
    this.wanderTimer -= 0.15;
    if (this.wanderTimer <= 0) {
      const r = Math.random();
      this.moveDir = r < 0.45 ? 0 : r < 0.72 ? 1 : -1;
      this.wanderTimer = 1 + Math.random() * 3;
      if (this.moveDir !== 0 && this.moveDir !== this.facing && this.turnCooldown <= 0) this.turn();
    }
    if (this.moveDir !== 0 && this.cliffAhead(this.moveDir as 1 | -1)) {
      this.moveDir = 0;
      this.wanderTimer = 0.5;
    }
  }

  private cliffAhead(dir: 1 | -1) {
    const t = this.root.body.translation();
    const ahead = this.physics.groundBelow(t.x + dir * 0.9 * this.scale, t.y, 3 * this.scale + 1, this.id);
    return ahead === null;
  }

  setGravityScale(gs: number) {
    this.gravityScale = gs;
    for (const p of this.parts) p.body.setGravityScale(gs, true);
  }

  /** Sync bones / fallback meshes to the rigid bodies. */
  syncVisuals() {
    const s = this.scale;
    if (this.bones.length) {
      const worlds = new Map<string, THREE.Matrix4>();
      for (const part of this.parts) {
        const t = part.body.translation();
        const r = part.body.rotation();
        const partScale = s * (part.spec.role === 'head' ? this.headMod : 1);
        worlds.set(part.spec.name, new THREE.Matrix4().compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(partScale, partScale, partScale)));
      }
      for (const b of this.bones) {
        const partWorld = worlds.get(b.part);
        if (!partWorld) continue;
        _m.multiplyMatrices(partWorld, b.offset);
        let parentWorld: THREE.Matrix4;
        if (b.parentPart) {
          const pw = worlds.get(b.parentPart)!;
          const pb = this.bones.find((x) => x.part === b.parentPart)!;
          parentWorld = _m2.multiplyMatrices(pw, pb.offset);
        } else {
          parentWorld = b.bone.parent ? b.bone.parent.matrixWorld : new THREE.Matrix4();
        }
        b.bone.matrix.copy(parentWorld).invert().multiply(_m);
        b.bone.matrixWorldNeedsUpdate = true;
      }
    } else {
      for (const part of this.parts) {
        const mesh = this.fallbackMeshes.get(part.spec.name);
        if (!mesh) continue;
        const t = part.body.translation();
        const r = part.body.rotation();
        mesh.matrix.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1));
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
    if (this.dizzy) {
      const h = this.head.body.translation();
      this.effects.updateDizzy(this.dizzy, h.x, h.y + 0.25 * s, this.time);
    }
    // Hurt flash: quick red tint on all materials.
    const flash = this.hurtFlash > 0 ? 1 : 0;
    if (flash !== (this.container.userData.flash ?? 0)) {
      this.container.userData.flash = flash;
      this.container.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const sm = mat as THREE.MeshStandardMaterial;
          if (sm.emissive) sm.emissive.set(flash ? 0xff3030 : 0x000000);
        }
      });
    }
  }

  /** Move the whole creature by a delta (edit mode drags). */
  translate(dx: number, dy: number) {
    for (const p of this.parts) {
      const t = p.body.translation();
      p.body.setTranslation({ x: t.x + dx, y: t.y + dy, z: t.z }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (this.heldItem) {
      const t = this.heldItem.body.translation();
      this.heldItem.body.setTranslation({ x: t.x + dx, y: t.y + dy, z: t.z }, true);
    }
  }

  /** Reset every part to the rest pose at a given feet position (used when placing in edit mode). */
  resetPose(x: number, y: number) {
    const q0 = this.facing === 1 ? new THREE.Quaternion() : Y180.clone();
    for (const p of this.parts) {
      const rest = new THREE.Vector3(p.spec.pos[0] * this.scale, p.spec.pos[1] * this.scale, p.spec.pos[2] * this.scale).applyQuaternion(q0);
      const q = q0.clone().multiply(p.restRot);
      p.body.setTranslation({ x: x + rest.x, y: y + rest.y, z: rest.z }, true);
      p.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (this.heldItem) this.heldItem.snapToHand();
  }

  meshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.container.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o);
    });
    return out;
  }

  /** Find the part nearest to a world point (for grabbing specific limbs). */
  nearestPart(x: number, y: number): Part {
    let best = this.root;
    let bd = Infinity;
    for (const p of this.parts) {
      const t = p.body.translation();
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }
}

export type { Part };
