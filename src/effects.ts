import * as THREE from 'three';
import { starTexture, textTexture } from './sprites';
import { HIT_WORDS } from './data';

interface Particle {
  sprite: THREE.Sprite;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  spin: number;
  gravity: number;
  grow: number;
}

/** Cartoon hit effects: bursts of stars, pop words, dizzy stars around knocked-out heads. */
export class Effects {
  group = new THREE.Group();
  private particles: Particle[] = [];
  private starMat: THREE.SpriteMaterial;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.starMat = new THREE.SpriteMaterial({ map: starTexture(), transparent: true, depthWrite: false });
  }

  stars(x: number, y: number, count = 6, power = 1) {
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(this.starMat.clone());
      const size = 0.25 + Math.random() * 0.25 * power;
      s.scale.set(size, size, 1);
      s.position.set(x, y, 1.2);
      this.group.add(s);
      const a = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 3) * power;
      this.particles.push({ sprite: s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 2, life: 0, maxLife: 0.6 + Math.random() * 0.4, spin: (Math.random() - 0.5) * 10, gravity: 9, grow: 0 });
    }
  }

  word(x: number, y: number, text?: string, color?: string) {
    const t = text ?? HIT_WORDS[Math.floor(Math.random() * HIT_WORDS.length)];
    const colors = ['#ffe14d', '#ff6b6b', '#7fd1ff', '#ff9f43', '#b0ff6b'];
    const mat = new THREE.SpriteMaterial({ map: textTexture(t, color ?? colors[Math.floor(Math.random() * colors.length)]), transparent: true, depthWrite: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(2.4, 0.8, 1);
    s.position.set(x, y + 0.4, 1.5);
    this.group.add(s);
    this.particles.push({ sprite: s, vx: (Math.random() - 0.5) * 1.5, vy: 2.5, life: 0, maxLife: 0.9, spin: 0, gravity: 3, grow: 0.6 });
  }

  puff(x: number, y: number, count = 4) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false });
      const s = new THREE.Sprite(mat);
      const size = 0.2 + Math.random() * 0.2;
      s.scale.set(size, size, 1);
      s.position.set(x + (Math.random() - 0.5) * 0.4, y, 1.1);
      this.group.add(s);
      this.particles.push({ sprite: s, vx: (Math.random() - 0.5) * 2, vy: 0.5 + Math.random(), life: 0, maxLife: 0.5, spin: 0, gravity: -1, grow: 1.5 });
    }
  }

  /** Persistent orbiting stars for a knocked-out creature. */
  makeDizzy(): THREE.Group {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(this.starMat.clone());
      s.scale.set(0.22, 0.22, 1);
      s.userData.phase = (i / 3) * Math.PI * 2;
      g.add(s);
    }
    this.group.add(g);
    return g;
  }

  updateDizzy(g: THREE.Group, x: number, y: number, t: number) {
    g.position.set(x, y, 1);
    g.children.forEach((c) => {
      const ph = c.userData.phase + t * 4;
      c.position.set(Math.cos(ph) * 0.3, Math.sin(ph) * 0.1 + 0.05, 0);
    });
  }

  removeDizzy(g: THREE.Group) {
    this.group.remove(g);
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.group.remove(p.sprite);
        (p.sprite.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= p.gravity * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.material.rotation += p.spin * dt;
      const k = 1 - p.life / p.maxLife;
      p.sprite.material.opacity = Math.min(1, k * 2);
      if (p.grow) {
        const g = 1 + p.grow * (p.life / p.maxLife);
        p.sprite.scale.x = p.sprite.scale.x * (1 + (p.grow * dt) / p.maxLife) ;
        p.sprite.scale.y = p.sprite.scale.y * (1 + (p.grow * dt) / p.maxLife) ;
        void g;
      }
    }
  }
}
