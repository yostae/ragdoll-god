import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics, PlaneLock } from './physics';
import type { BlockData, MaterialDef } from './types';
import { MATERIALS } from './data';
import { materialTexture } from './sprites';

let nextId = 1;
const DEPTH = 1.0;

/** A rectangle of material. Anchored blocks are fixed in place; loose ones tumble. */
export class Block {
  id = nextId++;
  material: MaterialDef;
  w: number;
  h: number;
  rot: number;
  anchored: boolean;
  body: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  mesh!: THREE.Mesh;
  pinMesh: THREE.Mesh | null = null;
  disposed = false;
  floating = false;
  private planeLock: PlaneLock | null = null;

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
    materialId: string,
    x: number,
    y: number,
    w: number,
    h: number,
    anchored?: boolean,
    rot = 0,
  ) {
    this.material = MATERIALS[materialId] ?? MATERIALS.wood;
    this.w = w;
    this.h = h;
    this.rot = rot;
    this.anchored = anchored ?? this.material.anchored;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rot * Math.PI) / 180);
    const desc = (this.anchored ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(x, y, 0)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.05)
      .setAngularDamping(0.2);
    this.body = this.physics.world.createRigidBody(desc);
    this.physics.register(this.body, { kind: 'block', id: this.id });
    if (!this.anchored) this.planeLock = this.physics.createPlaneLock(this.body, { x: 0, y: 0, z: 0, w: 1 });
    this.buildCollider();
    this.buildMesh();
    this.syncVisuals();
  }

  private buildCollider() {
    if (this.collider) this.physics.world.removeCollider(this.collider, true);
    const cd = RAPIER.ColliderDesc.cuboid(this.w / 2, this.h / 2, DEPTH * 0.3)
      .setDensity(this.material.density)
      .setFriction(this.material.friction)
      .setRestitution(this.material.restitution)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = this.physics.world.createCollider(cd, this.body);
    this.physics.registerCollider(this.collider, { kind: 'block', id: this.id });
  }

  private buildMesh() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    const tex = materialTexture(this.material).clone();
    tex.repeat.set(this.w, this.h);
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: this.material.pattern === 'metal' ? 0.3 : 0 });
    if (this.material.id === 'ice') {
      mat.transparent = true;
      mat.opacity = 0.85;
    }
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(this.w, this.h, DEPTH), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    this.updatePinMesh();
  }

  private updatePinMesh() {
    if (this.pinMesh) {
      this.mesh.remove(this.pinMesh);
      this.pinMesh = null;
    }
    // Loose blocks get a small corner marker so kids can tell what will fall.
    if (!this.anchored) {
      const g = new THREE.BoxGeometry(0.12, 0.12, 0.02);
      const m = new THREE.MeshBasicMaterial({ color: 0xffe14d });
      this.pinMesh = new THREE.Mesh(g, m);
      this.pinMesh.position.set(-this.w / 2 + 0.12, this.h / 2 - 0.12, DEPTH / 2 + 0.01);
      this.mesh.add(this.pinMesh);
    }
  }

  setMaterial(id: string) {
    const m = MATERIALS[id];
    if (!m) return;
    this.material = m;
    this.buildCollider();
    this.buildMesh();
    this.body.wakeUp();
  }

  setAnchored(a: boolean) {
    if (this.anchored === a) return;
    this.anchored = a;
    this.body.setBodyType(a ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);
    if (!a) this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    if (!a && !this.planeLock) this.planeLock = this.physics.createPlaneLock(this.body, { x: 0, y: 0, z: 0, w: 1 });
    this.updatePinMesh();
  }

  resize(w: number, h: number) {
    this.w = Math.max(0.25, w);
    this.h = Math.max(0.25, h);
    this.buildCollider();
    this.buildMesh();
    this.body.wakeUp();
  }

  setFloating(on: boolean) {
    this.floating = on;
    this.body.setGravityScale(on ? 0.02 : 1, true);
    if (on) this.setAnchored(false);
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

  serialize(): BlockData {
    const t = this.body.translation();
    const r = this.body.rotation();
    const ang = (2 * Math.atan2(r.z, r.w) * 180) / Math.PI;
    return { material: this.material.id, x: +t.x.toFixed(3), y: +t.y.toFixed(3), w: this.w, h: this.h, anchored: this.anchored, rot: +ang.toFixed(1) || undefined };
  }

  dispose() {
    this.disposed = true;
    if (this.planeLock) this.physics.removePlaneLock(this.planeLock);
    this.physics.removeBody(this.body);
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
