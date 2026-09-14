import RAPIER from '@dimforge/rapier3d-compat';

// Every rigid body carries an EntityRef in userData so contacts can be routed.
export interface EntityRef {
  kind: 'creature' | 'block' | 'item';
  id: number;
  part?: string; // creature part name
  holder?: number; // items: id of the creature holding it
  soft?: boolean; // legs/feet: collide with the world but never with other creatures
}

export interface PlaneLock {
  anchor: RAPIER.RigidBody;
  joint: RAPIER.ImpulseJoint;
}

export interface ContactHit {
  a: EntityRef;
  b: EntityRef;
  force: number;
  point: { x: number; y: number; z: number };
}

export class Physics {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  hooks: RAPIER.PhysicsHooks;
  hits: ContactHit[] = [];
  private bodyRefs = new Map<number, EntityRef>(); // body handle -> ref
  private colliderRefs = new Map<number, EntityRef>(); // collider handle -> ref
  accumulator = 0;
  readonly dt = 1 / 60;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.dt;
    this.world.numSolverIterations = 8;
    this.eventQueue = new RAPIER.EventQueue(true);
    const refs = this.bodyRefs;
    this.hooks = {
      filterContactPair(_c1, _c2, b1, b2) {
        const r1 = refs.get(b1);
        const r2 = refs.get(b2);
        // Parts of the same creature never collide with each other (legs overlap in the plane).
        if (r1 && r2 && r1.kind === 'creature' && r2.kind === 'creature' && r1.id === r2.id) return null;
        // Legs pop violently when they turn solid inside another creature, so they never touch creatures.
        if (r1 && r2 && ((r1.soft && r2.kind === 'creature') || (r2.soft && r1.kind === 'creature'))) return null;
        // A held item never collides with its holder.
        if (r1 && r2 && r1.kind === 'item' && r2.kind === 'creature' && r1.holder === r2.id) return null;
        if (r1 && r2 && r2.kind === 'item' && r1.kind === 'creature' && r2.holder === r1.id) return null;
        return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      },
      filterIntersectionPair(_c1, _c2, b1, b2) {
        const r1 = refs.get(b1);
        const r2 = refs.get(b2);
        if (r1 && r2 && r1.kind === 'creature' && r2.kind === 'creature' && r1.id === r2.id) return false;
        return true;
      },
    };
  }

  /**
   * Keep a body in the XY plane with a generic joint to a private fixed anchor. Rapier's built-in
   * axis locks blow up when combined with hinge joints, so the plane constraint is a joint too.
   * The anchor's rotation must match the body's "facing" rotation (identity or 180 degrees about Y).
   */
  createPlaneLock(body: RAPIER.RigidBody, rot: { x: number; y: number; z: number; w: number }): PlaneLock {
    const t = body.translation();
    const anchor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z).setRotation(rot));
    const mask = RAPIER.JointAxesMask.LinZ | RAPIER.JointAxesMask.AngX | RAPIER.JointAxesMask.AngY;
    // Axis +X makes the joint frame the identity, so the mask axes are plain world axes.
    const jd = RAPIER.JointData.generic({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, mask);
    const joint = this.world.createImpulseJoint(jd, anchor, body, true);
    return { anchor, joint };
  }

  setPlaneLockRotation(lock: PlaneLock, rot: { x: number; y: number; z: number; w: number }, body: RAPIER.RigidBody) {
    const t = body.translation();
    lock.anchor.setTranslation({ x: t.x, y: t.y, z: t.z }, false);
    lock.anchor.setRotation(rot, false);
  }

  removePlaneLock(lock: PlaneLock) {
    this.world.removeImpulseJoint(lock.joint, true);
    this.world.removeRigidBody(lock.anchor);
  }

  setGravity(g: number) {
    this.world.gravity = { x: 0, y: -g, z: 0 };
  }

  register(body: RAPIER.RigidBody, ref: EntityRef) {
    this.bodyRefs.set(body.handle, ref);
    body.userData = ref;
    for (let i = 0; i < body.numColliders(); i++) this.colliderRefs.set(body.collider(i).handle, ref);
  }

  registerCollider(collider: RAPIER.Collider, ref: EntityRef) {
    this.colliderRefs.set(collider.handle, ref);
  }

  refOfCollider(handle: number) {
    return this.colliderRefs.get(handle);
  }

  refOfBody(handle: number) {
    return this.bodyRefs.get(handle);
  }

  removeBody(body: RAPIER.RigidBody) {
    for (let i = 0; i < body.numColliders(); i++) this.colliderRefs.delete(body.collider(i).handle);
    this.bodyRefs.delete(body.handle);
    this.world.removeRigidBody(body);
  }

  /** Advance the simulation by real elapsed seconds with a fixed 60 Hz step. Returns steps taken. */
  step(elapsed: number, beforeStep?: () => void): number {
    this.accumulator = Math.min(this.accumulator + elapsed, 0.1);
    let steps = 0;
    while (this.accumulator >= this.dt) {
      beforeStep?.();
      this.world.step(this.eventQueue, this.hooks);
      this.collectEvents();
      this.accumulator -= this.dt;
      steps++;
    }
    return steps;
  }

  private collectEvents() {
    // A contact that just started, with the relative speed of the two bodies. That speed is a
    // much better "how hard was the bonk" signal than summed contact forces.
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.colliderRefs.get(h1);
      const b = this.colliderRefs.get(h2);
      if (!a || !b) return;
      const c1 = this.world.getCollider(h1);
      const c2 = this.world.getCollider(h2);
      if (!c1 || !c2) return;
      if (c1.isSensor() || c2.isSensor()) return; // cosmetic legs never count as hits
      const b1 = c1.parent();
      const b2 = c2.parent();
      const v1 = b1 ? b1.linvel() : { x: 0, y: 0, z: 0 };
      const v2 = b2 ? b2.linvel() : { x: 0, y: 0, z: 0 };
      const rel = Math.hypot(v1.x - v2.x, v1.y - v2.y);
      const p1 = c1.translation();
      const p2 = c2.translation();
      this.hits.push({ a, b, force: rel, point: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 } });
    });
    this.eventQueue.drainContactForceEvents(() => {});
  }

  /** Cast a ray downward from a point, ignoring a given creature, and return ground Y or null. */
  groundBelow(x: number, y: number, maxDist: number, ignoreCreature?: number): number | null {
    const ray = new RAPIER.Ray({ x, y, z: 0 }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, maxDist, true, undefined, undefined, undefined, undefined, (col) => {
      const ref = this.colliderRefs.get(col.handle);
      if (!ref) return true;
      if (ref.kind === 'creature') return false; // creatures don't stand on each other's springs
      if (ref.kind === 'item') return false;
      return true;
    });
    if (!hit) return null;
    return y - hit.timeOfImpact;
  }

  /** Line of sight between two points, blocked only by blocks. */
  lineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return true;
    const ray = new RAPIER.Ray({ x: ax, y: ay, z: 0 }, { x: dx / len, y: dy / len, z: 0 });
    const hit = this.world.castRay(ray, len, true, undefined, undefined, undefined, undefined, (col) => {
      const ref = this.colliderRefs.get(col.handle);
      return !!ref && ref.kind === 'block';
    });
    return !hit;
  }
}

export { RAPIER };
