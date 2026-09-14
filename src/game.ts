import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics, type EntityRef } from './physics';
import { Renderer } from './render';
import { Effects } from './effects';
import { Creature } from './creature';
import { Block } from './block';
import { Item } from './item';
import { Decor } from './decor';
import { CREATURES, ITEMS, MATERIAL_ORDER } from './data';
import type { ItemKind, MapData } from './types';
import { buildModContext, type ModContext } from './mods';

export type Mode = 'edit' | 'play' | 'pause';
export type Entity = Creature | Block | Item | Decor;

export interface Pick {
  entity: Entity;
  point: THREE.Vector3;
}

interface Grab {
  entity: Entity;
  body: RAPIER.RigidBody | null; // the specific body being pulled (a creature part, an item, a loose block)
  target: THREE.Vector2;
  last: THREE.Vector2;
  kinematic: boolean; // edit mode or anchored block: move directly
}

/** Owns the world: entities, mode, God interactions and the fixed-step update loop. */
export class Game {
  physics = new Physics();
  renderer: Renderer;
  effects: Effects;
  creatures: Creature[] = [];
  blocks: Block[] = [];
  items: Item[] = [];
  decor: Decor[] = [];
  mode: Mode = 'edit';
  map: MapData;
  snapshot: MapData | null = null;
  modCtx: ModContext = buildModContext([]);
  activeMods: string[] = [];
  grab: Grab | null = null;
  onModeChange: (m: Mode) => void = () => {};
  onToast: (msg: string) => void = () => {};
  private itemCooldown = new Map<number, number>();
  private clock = 0;

  constructor(container: HTMLElement, initialMap: MapData) {
    this.renderer = new Renderer(container);
    this.effects = new Effects(this.renderer.scene);
    this.map = initialMap;
    this.loadMap(initialMap);
  }

  // ---------- map lifecycle ----------

  clear() {
    this.grab = null;
    for (const c of this.creatures) c.dispose();
    for (const i of this.items) i.dispose();
    for (const b of this.blocks) b.dispose();
    for (const d of this.decor) d.dispose();
    this.creatures = [];
    this.items = [];
    this.blocks = [];
    this.decor = [];
    this.physics.hits.length = 0;
  }

  loadMap(map: MapData) {
    this.clear();
    this.map = map;
    for (const b of map.blocks) this.spawnBlock(b.material, b.x, b.y, b.w, b.h, b.anchored, b.rot ?? 0);
    for (const d of map.decor) this.spawnDecor(d.id, d.x, d.y, d.scale, d.layer);
    for (const c of map.creatures) {
      const cr = this.spawnCreature(c.spec, c.x, c.y, c.facing, c.scale, c.tint, false);
      if (cr && c.item) {
        const it = this.spawnItem(c.item, c.x, c.y + 1);
        if (it) cr.holdItem(it);
      }
    }
    for (const i of map.items) this.spawnItem(i.kind, i.x, i.y);
    this.renderer.target.set(map.camera.x, map.camera.y);
    this.renderer.zoom = map.camera.zoom;
    if (map.sky) {
      const [top, bottom] = map.sky.split(',');
      this.renderer.setSky(top, bottom);
    }
    this.applyMods();
    this.setMode('edit');
    this.syncVisuals();
  }

  serialize(name: string): MapData {
    return {
      name,
      version: 1,
      gravity: this.map.gravity,
      sky: this.map.sky,
      preset: false,
      camera: { x: +this.renderer.target.x.toFixed(2), y: +this.renderer.target.y.toFixed(2), zoom: +this.renderer.zoom.toFixed(1) },
      blocks: this.blocks.map((b) => b.serialize()),
      decor: this.decor.map((d) => d.serialize()),
      creatures: this.creatures.map((c) => {
        const t = c.root.body.translation();
        return { spec: c.spec.id, x: +t.x.toFixed(2), y: +(t.y - c.spec.standHeight * c.scale).toFixed(2), facing: c.facing, scale: c.scale, tint: c.tint, item: c.heldItem?.def.id };
      }),
      items: this.items.filter((i) => !i.heldBy).map((i) => {
        const t = i.body.translation();
        return { kind: i.def.id, x: +t.x.toFixed(2), y: +t.y.toFixed(2) };
      }),
    };
  }

  setMode(m: Mode) {
    if (m === 'play' && this.mode === 'edit') {
      this.snapshot = this.serialize(this.map.name);
      for (const c of this.creatures) if (c.state !== 'ko') c.setState('gettingUp', 0.3);
    }
    this.mode = m;
    this.onModeChange(m);
  }

  togglePlay() {
    if (this.mode === 'play') this.setMode('pause');
    else this.setMode('play');
  }

  reset() {
    const snap = this.snapshot ?? this.map;
    const cam = { x: this.renderer.target.x, y: this.renderer.target.y, zoom: this.renderer.zoom };
    this.loadMap({ ...snap, camera: cam, sky: this.map.sky });
    this.snapshot = null;
  }

  setActiveMods(ids: string[]) {
    this.activeMods = ids;
    this.applyMods();
  }

  private applyMods() {
    this.modCtx = buildModContext(this.activeMods);
    this.physics.setGravity(this.map.gravity * this.modCtx.gravity);
    for (const b of this.blocks) b.collider.setRestitution(this.modCtx.bouncyWorld ? 1.1 : b.material.restitution);
  }

  // ---------- spawning ----------

  spawnCreature(specId: string, x: number, y: number, facing: 1 | -1 = 1, scale = 1, tint?: string, useMods = true): Creature | null {
    const spec = CREATURES[specId];
    if (!spec) return null;
    let headMod = 1;
    if (useMods) {
      scale *= this.modCtx.creatureScale;
      headMod = this.modCtx.headScale;
      if (this.modCtx.rainbow && !tint) tint = `hsl(${Math.floor(Math.random() * 360)}, 90%, 60%)`;
    }
    const c = new Creature(this.physics, this.renderer.scene, this.effects, spec, x, y, facing, scale, tint, headMod);
    c.container.userData.entity = c;
    if (this.mode === 'edit') c.setState('upright');
    else c.setState('gettingUp', 0.3);
    this.creatures.push(c);
    return c;
  }

  spawnBlock(material: string, x: number, y: number, w: number, h: number, anchored?: boolean, rot = 0): Block {
    const b = new Block(this.physics, this.renderer.scene, material, x, y, w, h, anchored, rot);
    b.mesh.userData.entity = b;
    if (this.modCtx.bouncyWorld) b.collider.setRestitution(1.1);
    this.blocks.push(b);
    return b;
  }

  spawnItem(kind: ItemKind, x: number, y: number): Item | null {
    const def = ITEMS[kind];
    if (!def) return null;
    const it = new Item(this.physics, this.renderer.scene, def, x, y);
    it.mesh.userData.entity = it;
    this.items.push(it);
    return it;
  }

  spawnDecor(id: string, x: number, y: number, scale = 1, layer?: number): Decor {
    const d = new Decor(this.renderer.scene, id, x, y, scale, layer);
    d.mesh.userData.entity = d;
    this.decor.push(d);
    return d;
  }

  remove(e: Entity) {
    if (this.grab?.entity === e) this.grab = null;
    if (e instanceof Creature) {
      if (e.heldItem) this.remove(e.heldItem);
      e.dispose();
      this.creatures = this.creatures.filter((c) => c !== e);
    } else if (e instanceof Block) {
      e.dispose();
      this.blocks = this.blocks.filter((b) => b !== e);
    } else if (e instanceof Item) {
      e.dispose();
      this.items = this.items.filter((i) => i !== e);
    } else {
      e.dispose();
      this.decor = this.decor.filter((d) => d !== e);
    }
  }

  /** Replace a creature with a re-scaled copy in the same place, keeping its item. */
  rescaleCreature(c: Creature, factor: number): Creature | null {
    const newScale = THREE.MathUtils.clamp(c.scale * factor, 0.35, 3.2);
    if (Math.abs(newScale - c.scale) < 1e-3) return c;
    const t = c.root.body.translation();
    const feetY = c.feetY;
    const item = c.heldItem;
    if (item) c.dropItem();
    const facing = c.facing;
    const tint = c.tint;
    const headMod = c.headMod;
    this.creatures = this.creatures.filter((x) => x !== c);
    c.dispose();
    const spec = c.spec;
    const nc = new Creature(this.physics, this.renderer.scene, this.effects, spec, t.x, feetY + 0.05, facing, newScale, tint, headMod);
    nc.container.userData.entity = nc;
    nc.setState(this.mode === 'edit' ? 'upright' : 'gettingUp', 0.5);
    this.creatures.push(nc);
    if (item) nc.holdItem(item);
    this.effects.puff(t.x, feetY + 0.3, 8);
    return nc;
  }

  // ---------- picking & God tools ----------

  pick(clientX: number, clientY: number): Pick | null {
    const rc = this.renderer.raycaster(clientX, clientY);
    const hits = rc.intersectObjects(this.renderer.scene.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData.entity) return { entity: o.userData.entity as Entity, point: h.point };
        o = o.parent;
      }
    }
    return null;
  }

  beginGrab(p: Pick, world: THREE.Vector3) {
    const e = p.entity;
    const target = new THREE.Vector2(world.x, world.y);
    const editing = this.mode !== 'play';
    if (e instanceof Creature) {
      const part = e.nearestPart(p.point.x, p.point.y);
      if (!editing) e.setGrabbed(true);
      this.grab = { entity: e, body: part.body, target, last: target.clone(), kinematic: editing };
    } else if (e instanceof Item) {
      if (e.heldBy && !editing) e.heldBy.dropItem();
      else if (e.heldBy) e.heldBy.dropItem();
      this.grab = { entity: e, body: e.body, target, last: target.clone(), kinematic: editing };
    } else if (e instanceof Block) {
      this.grab = { entity: e, body: e.body, target, last: target.clone(), kinematic: editing || e.anchored };
    } else {
      this.grab = { entity: e, body: null, target, last: target.clone(), kinematic: true };
    }
  }

  moveGrab(world: THREE.Vector3) {
    if (!this.grab) return;
    const g = this.grab;
    g.target.set(world.x, world.y);
    if (g.kinematic) {
      const dx = g.target.x - g.last.x;
      const dy = g.target.y - g.last.y;
      g.entity.translate(dx, dy);
      g.last.copy(g.target);
      if (g.entity instanceof Creature) g.entity.syncVisuals();
    }
  }

  endGrab(dropTarget?: Pick | null) {
    const g = this.grab;
    if (!g) return;
    this.grab = null;
    g.body?.resetForces(true);
    if (g.entity instanceof Creature) {
      if (this.mode === 'play') g.entity.setGrabbed(false);
      else {
        // Snap a creature placed in edit mode onto the ground below it.
        const t = g.entity.root.body.translation();
        const ground = this.physics.groundBelow(t.x, t.y, 6, g.entity.id);
        if (ground !== null) g.entity.resetPose(t.x, ground + 0.01);
        g.entity.syncVisuals();
      }
    } else if (g.entity instanceof Item) {
      // Dropping an item onto a creature puts it in their hand.
      if (dropTarget && dropTarget.entity instanceof Creature) {
        dropTarget.entity.holdItem(g.entity);
        this.effects.stars(dropTarget.point.x, dropTarget.point.y, 4, 0.6);
        this.onToast(`${dropTarget.entity.spec.name} grabs the ${g.entity.def.name}!`);
      }
    }
  }

  /** The God uses an item directly on something. */
  useItem(kind: ItemKind, p: Pick) {
    this.applyItemEffect(kind, p.entity, p.point, null);
  }

  private applyItemEffect(kind: ItemKind, target: Entity, point: THREE.Vector3, holder: Creature | null) {
    const fx = (n = 6) => {
      this.effects.stars(point.x, point.y, n, 1);
    };
    switch (kind) {
      case 'growWand':
        if (target instanceof Creature) {
          this.rescaleCreature(target, 1.3);
        } else if (target instanceof Block) {
          if (target.w * 1.3 <= 12 && target.h * 1.3 <= 12) target.resize(target.w * 1.3, target.h * 1.3);
        } else if (target instanceof Decor) {
          target.scale = Math.min(4, target.scale * 1.3);
          target.update();
        }
        fx();
        break;
      case 'shrinkWand':
        if (target instanceof Creature) {
          this.rescaleCreature(target, 1 / 1.3);
        } else if (target instanceof Block) target.resize(target.w / 1.3, target.h / 1.3);
        else if (target instanceof Decor) {
          target.scale = Math.max(0.3, target.scale / 1.3);
          target.update();
        }
        fx();
        break;
      case 'transmuteWand':
        if (target instanceof Block) {
          const i = MATERIAL_ORDER.indexOf(target.material.id);
          const next = MATERIAL_ORDER[(i + 1) % MATERIAL_ORDER.length];
          target.setMaterial(next);
          fx();
        } else if (target instanceof Creature) {
          target.knockDown(1.5);
          fx();
        }
        break;
      case 'bonkHammer':
        if (target instanceof Creature) {
          const dir = holder ? holder.facing : 0;
          target.knockDown(0.6);
          target.hurt(30, point.x - dir);
          for (const p of target.supports) p.body.applyImpulse({ x: dir * target.totalMass * 3, y: target.totalMass * 4, z: 0 }, true);
          this.renderer.shake = 0.35;
          fx(10);
        } else if (target instanceof Block) {
          this.smashBlock(target, point);
        } else if (target instanceof Item) {
          target.body.applyImpulse({ x: (Math.random() - 0.5) * target.def.mass * 6, y: target.def.mass * 8, z: 0 }, true);
          fx(4);
        }
        break;
      case 'feather':
        if (target instanceof Creature) {
          const on = target.gravityScale >= 1;
          target.setGravityScale(on ? 0.04 : 1);
          target.floatTimer = on ? 8 : 0;
          if (on) for (const p of target.supports) p.body.applyImpulse({ x: 0, y: target.totalMass * 2, z: 0 }, true);
        } else if (target instanceof Block) {
          target.setFloating(!target.floating);
          if (target.floating) target.body.applyImpulse({ x: 0, y: target.body.mass() * 1.5, z: 0 }, true);
        } else if (target instanceof Item) {
          target.setFloating(target.body.gravityScale() >= 1);
        }
        fx(4);
        break;
    }
  }

  /** Hammer time: big blocks shatter into loose quarters, small ones crumble away. */
  smashBlock(b: Block, point: THREE.Vector3) {
    const t = b.body.translation();
    this.effects.puff(point.x, point.y, 8);
    this.effects.stars(point.x, point.y, 6, 1);
    this.renderer.shake = 0.25;
    const material = b.material.id;
    if (b.w * b.h <= 0.6 || b.w * b.h > 60) {
      // Tiny pieces vanish; the huge ground slabs just take the hit.
      if (b.w * b.h <= 0.6) this.remove(b);
      else this.effects.puff(point.x, point.y, 6);
      return;
    }
    const w = b.w / 2;
    const h = b.h / 2;
    this.remove(b);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const nb = this.spawnBlock(material, t.x + (sx * w) / 2, t.y + (sy * h) / 2, w, h, false);
        nb.body.applyImpulse({ x: sx * nb.body.mass() * (1.5 + Math.random()), y: nb.body.mass() * (2 + Math.random() * 2), z: 0 }, true);
        nb.body.applyTorqueImpulse({ x: 0, y: 0, z: (Math.random() - 0.5) * nb.body.mass() }, true);
      }
  }

  // ---------- update loop ----------

  update(dt: number) {
    this.clock += dt;
    if (this.mode === 'play') {
      const scaled = dt * this.modCtx.slowMo;
      for (const c of this.creatures) c.think(scaled, this.creatures, this.items);
      this.physics.step(scaled, () => this.beforeStep());
      this.processHits();
      this.killFloor();
    }
    this.syncVisuals();
    this.effects.update(dt);
    this.renderer.render(dt);
  }

  private beforeStep() {
    const dt = this.physics.dt;
    for (const c of this.creatures) c.controlStep(dt);
    this.processStrikes();
    const g = this.grab;
    if (g && g.body && !g.kinematic) {
      const t = g.body.translation();
      const v = g.body.linvel();
      const m = Math.max(g.body.mass(), 0.2);
      const extra = g.entity instanceof Creature ? g.entity.totalMass * 0.6 : 0;
      const k = 120 * (m + extra);
      const c = 12 * (m + extra);
      let fx = k * (g.target.x - t.x) - c * v.x;
      let fy = k * (g.target.y - t.y) - c * v.y + (m + extra) * 9.81 * 0.5;
      const maxF = (m + extra) * 250;
      const mag = Math.hypot(fx, fy);
      if (mag > maxF) {
        fx *= maxF / mag;
        fy *= maxF / mag;
      }
      if (!(g.entity instanceof Creature)) g.body.resetForces(false);
      g.body.addForce({ x: fx, y: fy, z: 0 }, true);
      g.body.wakeUp();
    }
  }

  /**
   * Attacks land by proximity during the swing, not by contact events: two fighters standing
   * chest to chest are in continuous contact, so Rapier never reports a "new" collision.
   */
  private processStrikes() {
    for (const a of this.creatures) {
      if (!a.inStrikeWindow()) continue;
      const striker = a.strikerBody();
      const sp = striker.translation();
      const reach = (a.heldItem ? 0.3 : 0.16) * a.scale + 0.05;
      const vel = striker.linvel();
      const speed = Math.hypot(vel.x, vel.y);
      let victim: Creature | null = null;
      let hitPoint: { x: number; y: number } | null = null;
      // The striker is a small body; look for the nearest enemy part instead of relying on contacts.
      for (const b of this.creatures) {
        if (b === a || b.disposed || !a.isEnemyOf(b) || b.state === 'ko') continue;
        for (const part of b.parts) {
          if (part.collider.isSensor()) continue;
          const pt = part.body.translation();
          const size = part.spec.size;
          const radius = (part.spec.shape === 'box' ? Math.max(size[0], size[1]) / 2 : part.spec.shape === 'capsule' ? size[1] / 2 + size[0] : size[0]) * b.scale;
          const d = Math.hypot(pt.x - sp.x, pt.y - sp.y);
          if (d <= radius + reach) {
            victim = b;
            hitPoint = { x: (pt.x + sp.x) / 2, y: (pt.y + sp.y) / 2 };
            break;
          }
        }
        if (victim) break;
      }
      if (!victim || !hitPoint) continue;
      a.struck = true;
      const mult = a.heldItem ? a.heldItem.def.strike : 1;
      const dmg = (7 + Math.min(speed, 8) * 1.5) * mult;
      const dir = Math.sign(victim.position.x - a.position.x) || a.facing;
      victim.hurt(dmg, a.position.x);
      for (const p of victim.supports) p.body.applyImpulse({ x: (dir * victim.totalMass * 1.6 * mult) / victim.supports.length, y: (victim.totalMass * 1.2 * mult) / victim.supports.length, z: 0 }, true);
      this.effects.stars(hitPoint.x, hitPoint.y, Math.min(12, 4 + dmg / 3), 1);
      if (mult > 1.5) this.renderer.shake = 0.3;
      if (a.heldItem && a.heldItem.def.id !== 'bonkHammer') this.applyItemEffect(a.heldItem.def.id, victim, new THREE.Vector3(hitPoint.x, hitPoint.y, 0), a);
    }
  }

  private resolve(ref: EntityRef): Entity | undefined {
    if (ref.kind === 'creature') return this.creatures.find((c) => c.id === ref.id);
    if (ref.kind === 'item') return this.items.find((i) => i.id === ref.id);
    return this.blocks.find((b) => b.id === ref.id);
  }

  private processHits() {
    const hits = this.physics.hits;
    if (!hits.length) return;
    for (const h of hits) {
      const speed = h.force;
      if (speed < 2.5) continue;
      const A = this.resolve(h.a);
      const B = this.resolve(h.b);
      if (!A || !B) continue;
      const base = (speed - 2.5) * 2.5;
      if (base <= 0) continue;
      const pt = h.point;

      if (A instanceof Creature && B instanceof Creature) {
        if (A === B) continue;
        const aAtt = A.attackTime >= 0;
        const bAtt = B.attackTime >= 0;
        if (aAtt && !bAtt) B.hurt(base * 1.3, A.position.x);
        else if (bAtt && !aAtt) A.hurt(base * 1.3, B.position.x);
        else {
          A.hurt(base * 0.25);
          B.hurt(base * 0.25);
        }
        this.effects.stars(pt.x, pt.y, Math.min(10, 3 + base / 4), 1);
        if (base > 20) this.renderer.shake = 0.25;
        continue;
      }
      const item = A instanceof Item ? A : B instanceof Item ? B : null;
      const other = item === A ? B : A;
      if (item) {
        const last = this.itemCooldown.get(item.id) ?? -1;
        if (this.clock - last < 0.4) continue;
        if (other instanceof Creature) {
          if (item.heldBy === other) continue;
          this.itemCooldown.set(item.id, this.clock);
          const mult = item.heldBy ? 1.6 : 0.6;
          other.hurt(base * item.def.strike * mult, item.heldBy ? item.heldBy.position.x : pt.x);
          this.effects.stars(pt.x, pt.y, Math.min(12, 4 + base / 3), 1.2);
          if (item.def.id !== 'bonkHammer' && item.heldBy) this.applyItemEffect(item.def.id, other, new THREE.Vector3(pt.x, pt.y, 0), item.heldBy);
          if (item.def.id === 'bonkHammer' && base > 10) this.renderer.shake = 0.3;
        } else if (other instanceof Block && item.heldBy && speed > 3) {
          this.itemCooldown.set(item.id, this.clock);
          if (item.def.id !== 'bonkHammer') this.applyItemEffect(item.def.id, other, new THREE.Vector3(pt.x, pt.y, 0), item.heldBy);
          else this.effects.stars(pt.x, pt.y, 4, 0.8);
        }
        continue;
      }
      // Creature vs block: falling onto things hurts a little and puffs dust.
      const cr = A instanceof Creature ? A : B instanceof Creature ? B : null;
      if (cr && speed > 6) {
        cr.hurt(base * 0.35);
        this.effects.puff(pt.x, pt.y, 4);
      }
    }
    hits.length = 0;
  }

  private killFloor() {
    const dead = (y: number) => y < -60;
    for (const c of [...this.creatures]) if (dead(c.root.body.translation().y)) this.remove(c);
    for (const i of [...this.items]) if (dead(i.body.translation().y)) this.remove(i);
    for (const b of [...this.blocks]) if (dead(b.body.translation().y)) this.remove(b);
  }

  syncVisuals() {
    for (const c of this.creatures) c.syncVisuals();
    for (const i of this.items) i.syncVisuals();
    for (const b of this.blocks) if (!b.anchored || this.mode !== 'play') b.syncVisuals();
  }
}
