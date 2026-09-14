import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics, EntityRef, PlaneLock } from './physics';
import type { ItemDef } from './types';
import type { Creature } from './creature';

let nextId = 1;
const TILT = -60 * (Math.PI / 180); // held items point forward-up

/** A magic item or weapon: a small dynamic body the God can use directly or place in a creature's hand. */
export class Item {
  id = nextId++;
  def: ItemDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh = new THREE.Group();
  heldBy: Creature | null = null;
  joint: RAPIER.ImpulseJoint | null = null;
  ref: EntityRef;
  disposed = false;
  private planeLock: PlaneLock | null = null;
  private floatMat: THREE.MeshStandardMaterial | null = null;

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
    def: ItemDef,
    x: number,
    y: number,
  ) {
    this.def = def;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, 0.2)
      .setLinearDamping(0.2)
      .setAngularDamping(0.8)
      .setCcdEnabled(true);
    this.body = this.physics.world.createRigidBody(desc);
    const [hx, hy, hz] = def.size;
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMass(def.mass)
      .setFriction(0.6)
      .setRestitution(0.2)
      .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = this.physics.world.createCollider(cd, this.body);
    this.ref = { kind: 'item', id: this.id };
    this.physics.register(this.body, this.ref);
    this.lockToPlane();
    this.buildMesh();
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    this.syncVisuals();
  }

  private buildMesh() {
    const [hx, hy, hz] = this.def.size;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), new THREE.MeshStandardMaterial({ color: this.def.handleColor, roughness: 0.9 }));
    handle.castShadow = true;
    this.mesh.add(handle);
    const headMat = new THREE.MeshStandardMaterial({ color: this.def.color, roughness: 0.6, emissive: this.def.id === 'bonkHammer' ? 0x000000 : new THREE.Color(this.def.color).multiplyScalar(0.25) });
    let head: THREE.Mesh;
    if (this.def.id === 'bonkHammer') head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.2), headMat);
    else if (this.def.id === 'feather') head = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.02), headMat);
    else head = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), headMat);
    head.position.y = hy - 0.02;
    head.castShadow = true;
    this.mesh.add(head);
  }

  private lockToPlane() {
    if (this.planeLock) return;
    this.planeLock = this.physics.createPlaneLock(this.body, { x: 0, y: 0, z: 0, w: 1 });
  }

  private unlockFromPlane() {
    if (!this.planeLock) return;
    this.physics.removePlaneLock(this.planeLock);
    this.planeLock = null;
  }

  attachTo(creature: Creature) {
    this.detach();
    this.heldBy = creature;
    // While held, the fixed joint to the hand keeps the item planar; a second lock would fight turn().
    this.unlockFromPlane();
    this.ref.holder = creature.id;
    this.snapToHand();
    const [, hy] = this.def.size;
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), TILT);
    const jd = RAPIER.JointData.fixed({ x: 0, y: 0, z: 0 }, { x: tilt.x, y: tilt.y, z: tilt.z, w: tilt.w }, { x: 0, y: -(hy - 0.06), z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    this.joint = this.physics.world.createImpulseJoint(jd, creature.gripPart.body, this.body, true);
    this.body.setGravityScale(creature.gravityScale, true);
  }

  /** Put the item exactly where the holder's hand is (used before creating the joint and on pose resets). */
  snapToHand() {
    if (!this.heldBy) return;
    const hand = this.heldBy.gripPart.body;
    const hp = hand.translation();
    const hr = hand.rotation();
    const hq = new THREE.Quaternion(hr.x, hr.y, hr.z, hr.w);
    const q = hq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), TILT));
    const [, hy] = this.def.size;
    const off = new THREE.Vector3(0, hy - 0.06, 0).applyQuaternion(q);
    this.body.setTranslation({ x: hp.x + off.x, y: hp.y + off.y, z: hp.z + 0.1 }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel(hand.linvel(), true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  detach() {
    if (this.joint) {
      this.physics.world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    if (this.heldBy) {
      const c = this.heldBy;
      this.heldBy = null;
      this.ref.holder = undefined;
      if (c.heldItem === this) c.heldItem = null;
      // Items dropped by a mirrored creature carry a 180-degree Y rotation; flatten it back to a Z spin.
      const r = this.body.rotation();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const ang = Math.atan2(-up.x, up.y);
      const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang);
      this.body.setRotation({ x: flat.x, y: flat.y, z: flat.z, w: flat.w }, true);
      if (!this.disposed) this.lockToPlane();
    }
  }

  setFloating(on: boolean) {
    this.body.setGravityScale(on ? 0.05 : 1, true);
    if (on && !this.floatMat) {
      this.floatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
      const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), this.floatMat);
      bubble.name = 'bubble';
      this.mesh.add(bubble);
    } else if (!on && this.floatMat) {
      const b = this.mesh.getObjectByName('bubble');
      if (b) this.mesh.remove(b);
      this.floatMat = null;
    }
  }

  syncVisuals() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.matrix.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  translate(dx: number, dy: number) {
    const t = this.body.translation();
    this.body.setTranslation({ x: t.x + dx, y: t.y + dy, z: t.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  meshes(): THREE.Object3D[] {
    return this.mesh.children;
  }

  dispose() {
    this.disposed = true;
    this.detach();
    this.unlockFromPlane();
    this.physics.removeBody(this.body);
    this.scene.remove(this.mesh);
  }
}
