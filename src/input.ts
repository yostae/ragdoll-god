import * as THREE from 'three';
import type { Game } from './game';
import { Creature } from './creature';
import { Block } from './block';
import { Item } from './item';
import { CREATURES, DECOR, ITEMS, MATERIALS } from './data';
import type { ItemKind } from './types';

export type Tool =
  | { type: 'hand' }
  | { type: 'delete' }
  | { type: 'pin' }
  | { type: 'flip' }
  | { type: 'place'; kind: 'creature' | 'item' | 'decor'; id: string }
  | { type: 'material'; id: string }
  | { type: 'use'; kind: ItemKind };

const GRID = 0.25;
const snap = (v: number) => Math.round(v / GRID) * GRID;

interface PointerState {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
}

/** Pointer, touch and keyboard handling for the canvas: camera, grabbing, placing, drawing blocks. */
export class Input {
  tool: Tool = { type: 'hand' };
  onToolChange: (t: Tool) => void = () => {};
  private pointers = new Map<number, PointerState>();
  private panning = false;
  private pinchDist = 0;
  private drawStart: THREE.Vector3 | null = null;
  private ghost: THREE.Mesh;
  private keys = new Set<string>();
  private lastTap = 0;

  constructor(
    private game: Game,
    private canvas: HTMLCanvasElement,
  ) {
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1.02), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost.visible = false;
    game.renderer.scene.add(this.ghost);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  setTool(t: Tool) {
    this.tool = t;
    this.ghost.visible = false;
    this.drawStart = null;
    this.onToolChange(t);
    const cursors: Record<Tool['type'], string> = { hand: 'grab', delete: 'not-allowed', pin: 'crosshair', flip: 'ew-resize', place: 'copy', material: 'crosshair', use: 'cell' };
    this.canvas.style.cursor = cursors[t.type];
  }

  /** Called every frame so held keys pan the camera smoothly. */
  update(dt: number) {
    const r = this.game.renderer;
    const speed = r.zoom * 0.9 * dt;
    if (this.keys.has('a') || this.keys.has('arrowleft')) r.target.x -= speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) r.target.x += speed;
    if (this.keys.has('w') || this.keys.has('arrowup')) r.target.y += speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) r.target.y -= speed;
    if (this.keys.has('q') || this.keys.has('-')) this.zoomBy(1 + dt);
    if (this.keys.has('e') || this.keys.has('=') || this.keys.has('+')) this.zoomBy(1 - dt);
  }

  private zoomBy(f: number, aroundX?: number, aroundY?: number) {
    const r = this.game.renderer;
    const before = aroundX !== undefined ? r.screenToWorld(aroundX, aroundY!) : null;
    r.zoom = THREE.MathUtils.clamp(r.zoom * f, r.minZoom, r.maxZoom);
    if (before) {
      r.camera.position.set(r.target.x, r.target.y, r.zoom);
      r.camera.updateMatrixWorld();
      const after = r.screenToWorld(aroundX!, aroundY!);
      r.target.x += before.x - after.x;
      r.target.y += before.y - after.y;
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.zoomBy(e.deltaY > 0 ? 1.12 : 0.89, e.clientX, e.clientY);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    if (k === ' ') {
      e.preventDefault();
      this.game.togglePlay();
    } else if (k === 'r') this.game.reset();
    else if (k === 'escape') this.setTool({ type: 'hand' });
    else if (k === 'h') this.setTool({ type: 'hand' });
    else if (k === 'x') this.setTool({ type: 'delete' });
    else if (k === 'p') this.setTool({ type: 'pin' });
    else if (k === 'f') this.setTool({ type: 'flip' });
  }

  private onDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false });
    if (this.pointers.size === 2) {
      // Second finger: cancel whatever the first was doing and start pinch/pan.
      this.cancelAction();
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.panning = true;
      return;
    }
    if (this.pointers.size > 2) return;
    const secondary = e.button === 1 || e.button === 2;
    if (secondary) {
      this.panning = true;
      return;
    }
    const world = this.game.renderer.screenToWorld(e.clientX, e.clientY);
    const t = this.tool;
    if (t.type === 'hand') {
      const p = this.game.pick(e.clientX, e.clientY);
      if (p) this.game.beginGrab(p, world);
      else this.panning = true;
    } else if (t.type === 'material') {
      this.drawStart = world;
      this.ghost.visible = true;
      this.updateGhost(world);
    }
    // Other tools act on pointer up so a drag can still pan the camera.
  }

  private onMove(e: PointerEvent) {
    const ps = this.pointers.get(e.pointerId);
    if (!ps) return;
    const dx = e.clientX - ps.x;
    const dy = e.clientY - ps.y;
    ps.x = e.clientX;
    ps.y = e.clientY;
    if (Math.hypot(e.clientX - ps.startX, e.clientY - ps.startY) > 8) ps.moved = true;
    const r = this.game.renderer;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) this.zoomBy(this.pinchDist / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinchDist = d;
      // Pan with the midpoint (average both fingers' motion).
      const scale = r.viewWidth() / this.canvas.clientWidth;
      r.target.x -= (dx * scale) / 2;
      r.target.y += (dy * scale) / 2;
      return;
    }
    if (this.panning) {
      const scale = r.viewWidth() / this.canvas.clientWidth;
      r.target.x -= dx * scale;
      r.target.y += dy * scale;
      return;
    }
    const world = r.screenToWorld(e.clientX, e.clientY);
    if (this.game.grab) this.game.moveGrab(world);
    else if (this.drawStart) this.updateGhost(world);
    else if (this.tool.type !== 'hand' && ps.moved && e.pointerType !== 'mouse') {
      // Dragging with a placement tool on touch pans the camera.
      this.panning = true;
    }
  }

  private onUp(e: PointerEvent) {
    const ps = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) {
      this.pinchDist = 0;
      if (this.pointers.size === 1) this.panning = true; // finish a pinch as a pan
      return;
    }
    const wasPanning = this.panning;
    this.panning = false;
    if (!ps) return;
    const world = this.game.renderer.screenToWorld(e.clientX, e.clientY);
    if (this.game.grab) {
      const target = this.game.grab.entity instanceof Item ? this.pickExcluding(e.clientX, e.clientY, this.game.grab.entity) : null;
      this.game.endGrab(target);
      return;
    }
    if (this.drawStart) {
      this.finishDraw(world);
      return;
    }
    if (wasPanning || ps.moved) return;
    this.tap(e.clientX, e.clientY, world);
  }

  private cancelAction() {
    if (this.game.grab) this.game.endGrab(null);
    this.drawStart = null;
    this.ghost.visible = false;
  }

  private pickExcluding(cx: number, cy: number, skip: Item) {
    const rc = this.game.renderer.raycaster(cx, cy);
    const hits = rc.intersectObjects(this.game.renderer.scene.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData.entity && o.userData.entity !== skip) return { entity: o.userData.entity, point: h.point };
        o = o.parent;
      }
    }
    return null;
  }

  private tap(cx: number, cy: number, world: THREE.Vector3) {
    const t = this.tool;
    const g = this.game;
    const now = performance.now();
    const doubleTap = now - this.lastTap < 300;
    this.lastTap = now;
    if (t.type === 'hand') {
      // Double-tap empty ground with the hand: nothing. Double-tap a creature: give it a little poke.
      const p = g.pick(cx, cy);
      if (p && doubleTap && p.entity instanceof Creature) {
        for (const part of p.entity.supports) part.body.applyImpulse({ x: 0, y: p.entity.totalMass * 3, z: 0 }, true);
        g.effects.word(p.point.x, p.point.y, 'BOING!', '#7fd1ff');
      }
      return;
    }
    if (t.type === 'place') {
      this.place(t, world);
      return;
    }
    if (t.type === 'material') return;
    const p = g.pick(cx, cy);
    if (!p) return;
    if (t.type === 'delete') {
      g.effects.puff(p.point.x, p.point.y, 5);
      g.remove(p.entity);
    } else if (t.type === 'pin') {
      if (p.entity instanceof Block) {
        p.entity.setAnchored(!p.entity.anchored);
        g.effects.word(p.point.x, p.point.y, p.entity.anchored ? 'PINNED' : 'LOOSE', '#ffd23f');
      }
    } else if (t.type === 'flip') {
      if (p.entity instanceof Creature) {
        p.entity.turn();
        p.entity.syncVisuals();
      }
    } else if (t.type === 'use') {
      g.useItem(t.kind, p);
    }
  }

  private place(t: Extract<Tool, { type: 'place' }>, world: THREE.Vector3) {
    const g = this.game;
    if (t.kind === 'creature') {
      const spec = CREATURES[t.id];
      if (!spec) return;
      const ground = g.physics.groundBelow(world.x, world.y + 0.2, 3);
      const y = ground !== null ? ground + 0.02 : world.y;
      const facing: 1 | -1 = world.x > g.renderer.target.x ? -1 : 1;
      const c = g.spawnCreature(t.id, world.x, y, facing);
      if (c) {
        c.syncVisuals();
        g.effects.puff(world.x, y + 0.3, 6);
      }
    } else if (t.kind === 'item') {
      if (!ITEMS[t.id]) return;
      const p = g.pick(0, 0);
      void p;
      const it = g.spawnItem(t.id as ItemKind, world.x, world.y);
      if (it) g.effects.stars(world.x, world.y, 4, 0.6);
    } else if (t.kind === 'decor') {
      if (!DECOR[t.id]) return;
      const ground = g.physics.groundBelow(world.x, world.y + 0.2, 3);
      const y = DECOR[t.id].layer <= -3 ? world.y : ground !== null ? ground : world.y;
      g.spawnDecor(t.id, world.x, y, 1);
    }
  }

  private rectFrom(a: THREE.Vector3, b: THREE.Vector3) {
    let x1 = snap(Math.min(a.x, b.x));
    let x2 = snap(Math.max(a.x, b.x));
    let y1 = snap(Math.min(a.y, b.y));
    let y2 = snap(Math.max(a.y, b.y));
    if (x2 - x1 < GRID) x2 = x1 + 1;
    if (y2 - y1 < GRID) y2 = y1 + 1;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 };
  }

  private updateGhost(world: THREE.Vector3) {
    if (!this.drawStart) return;
    const rct = this.rectFrom(this.drawStart, world);
    this.ghost.position.set(rct.x, rct.y, 0);
    this.ghost.scale.set(rct.w, rct.h, 1);
    const mat = this.tool.type === 'material' ? MATERIALS[this.tool.id] : null;
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(mat?.color ?? '#ffffff');
  }

  private finishDraw(world: THREE.Vector3) {
    const start = this.drawStart!;
    this.drawStart = null;
    this.ghost.visible = false;
    if (this.tool.type !== 'material') return;
    const rct = this.rectFrom(start, world);
    if (rct.w > 40 || rct.h > 40) return;
    this.game.spawnBlock(this.tool.id, rct.x, rct.y, rct.w, rct.h);
    this.game.effects.puff(rct.x, rct.y, 3);
  }
}
