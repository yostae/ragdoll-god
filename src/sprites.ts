// Procedural pixel-art textures. Every function draws on a small canvas so the art can be
// swapped for Retro Diffusion PNGs later (drop files in public/art/ and point the loader there).
import * as THREE from 'three';
import type { MaterialDef } from './types';

const cache = new Map<string, THREE.Texture>();

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

function pixelTexture(c: HTMLCanvasElement, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Deterministic tiny PRNG so textures look the same every load.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function shade(hex: string, amt: number) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amt);
  return '#' + c.getHexString();
}

// One tile = 1 meter = 16 px.
export function materialTexture(m: MaterialDef): THREE.Texture {
  const key = 'mat:' + m.id;
  if (cache.has(key)) return cache.get(key)!;
  const S = 16;
  const { c, ctx } = makeCanvas(S, S);
  const r = rng(m.id.length * 977 + 13);
  ctx.fillStyle = m.color;
  ctx.fillRect(0, 0, S, S);
  const px = (x: number, y: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  };
  switch (m.pattern) {
    case 'grass':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (y < 3) px(x, y, r() < 0.8 ? m.color2 : shade(m.color2, 0.12));
          else if (y === 3 && r() < 0.5) px(x, y, m.color2);
          else if (r() < 0.12) px(x, y, shade(m.color, r() < 0.5 ? -0.08 : 0.06));
        }
      break;
    case 'planks':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (y % 4 === 0) px(x, y, m.color2);
          else if ((x + (y >> 2) * 5) % 8 === 0) px(x, y, m.color2);
          else if (r() < 0.1) px(x, y, shade(m.color, -0.05));
        }
      break;
    case 'bricks':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const row = y >> 2;
          const off = row % 2 ? 4 : 0;
          if (y % 4 === 3 || (x + off) % 8 === 7) px(x, y, m.color2);
          else if (r() < 0.08) px(x, y, shade(m.color, 0.06));
        }
      break;
    case 'stone':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const blob = Math.sin(x * 1.3 + y * 0.7) + Math.cos(y * 1.1 - x * 0.4);
          if (blob > 1.2) px(x, y, shade(m.color, 0.08));
          else if (blob < -1.1) px(x, y, m.color2);
          else if (r() < 0.06) px(x, y, m.color2);
        }
      break;
    case 'metal':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (x === 0 || y === 0) px(x, y, shade(m.color, 0.1));
          else if (x === S - 1 || y === S - 1) px(x, y, m.color2);
          else if ((x === 2 || x === S - 3) && (y === 2 || y === S - 3)) px(x, y, m.color2);
        }
      break;
    case 'sand':
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (r() < 0.2) px(x, y, r() < 0.5 ? m.color2 : shade(m.color, 0.06));
      break;
    case 'ice':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if ((x + y) % 9 === 0) px(x, y, shade(m.color, 0.1));
          else if ((x * 3 + y) % 11 === 0) px(x, y, m.color2);
        }
      break;
    case 'cloud':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const d = Math.hypot(x - 8, y - 8);
          if (d > 6.5 && r() < 0.6) px(x, y, m.color2);
          else if (r() < 0.05) px(x, y, m.color2);
        }
      break;
    case 'lava':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const w = Math.sin(x * 0.9 + y * 0.5) + Math.cos(y * 1.3 - x * 0.3);
          if (w > 1.0) px(x, y, m.color2);
          else if (w < -1.2) px(x, y, shade(m.color, -0.18));
          else if (r() < 0.06) px(x, y, '#fff2a0');
        }
      break;
    case 'moon':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const d1 = Math.hypot(x - 5, y - 6);
          const d2 = Math.hypot(x - 12, y - 12);
          if (d1 < 2.5 || d2 < 1.8) px(x, y, m.color2);
          else if (d1 < 3.2 || d2 < 2.5) px(x, y, shade(m.color, 0.08));
          else if (r() < 0.08) px(x, y, m.color2);
        }
      break;
    case 'gold':
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (x === 0 || y === 0) px(x, y, shade(m.color, 0.18));
          else if (x === S - 1 || y === S - 1) px(x, y, m.color2);
          else if ((x + y) % 7 === 0) px(x, y, shade(m.color, 0.12));
          else if (r() < 0.05) px(x, y, '#fff7c0');
        }
      break;
  }
  const t = pixelTexture(c, true);
  cache.set(key, t);
  return t;
}

export function starTexture(): THREE.Texture {
  const key = 'fx:star';
  if (cache.has(key)) return cache.get(key)!;
  const { c, ctx } = makeCanvas(16, 16);
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 ? 3 : 7.5;
    pts.push([8 + Math.cos(a) * rad, 8 + Math.sin(a) * rad]);
  }
  ctx.fillStyle = '#ffe14d';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff7b0';
  ctx.fillRect(7, 6, 2, 2);
  const t = pixelTexture(c);
  cache.set(key, t);
  return t;
}

export function textTexture(text: string, color = '#ffffff', outline = '#222222'): THREE.Texture {
  const key = 'txt:' + text + color;
  if (cache.has(key)) return cache.get(key)!;
  const { c, ctx } = makeCanvas(96, 32);
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = outline;
  ctx.strokeText(text, 48, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, 48, 16);
  const t = pixelTexture(c);
  cache.set(key, t);
  return t;
}

export function decorTexture(id: string): THREE.Texture {
  const key = 'decor:' + id;
  if (cache.has(key)) return cache.get(key)!;
  let W = 32,
    H = 48;
  if (id === 'cloud') (W = 48), (H = 20);
  if (id === 'sun') (W = 32), (H = 32);
  if (id === 'bush') (W = 32), (H = 20);
  if (id === 'flower') (W = 24), (H = 16);
  if (id === 'rock') (W = 24), (H = 16);
  if (id === 'castle') (W = 96), (H = 72);
  if (id === 'volcano') (W = 112), (H = 72);
  if (id === 'deadtree') (W = 24), (H = 40);
  if (id === 'stars') (W = 80), (H = 48);
  if (id === 'earth') (W = 32), (H = 32);
  if (id === 'crater') (W = 48), (H = 12);
  if (id === 'moonflag') (W = 18), (H = 32);
  const { c, ctx } = makeCanvas(W, H);
  const r = rng(id.length * 31 + 7);
  const px = (x: number, y: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  };
  const disc = (cx: number, cy: number, rad: number, col: string, col2?: string) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rad) px(x, y, col2 && r() < 0.18 ? col2 : col);
      }
  };
  const rect = (x: number, y: number, w: number, h: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  };
  switch (id) {
    case 'tree':
      rect(13, 26, 6, 22, '#6b4423');
      rect(15, 26, 2, 22, '#5a3618');
      disc(16, 16, 12, '#3f9b3a', '#6fcf5c');
      disc(9, 20, 7, '#3f9b3a', '#6fcf5c');
      disc(23, 20, 7, '#3f9b3a', '#6fcf5c');
      for (let i = 0; i < 8; i++) px(6 + r() * 20, 8 + r() * 16, '#e14d4d');
      break;
    case 'pine':
      rect(14, 38, 4, 10, '#5a3618');
      for (let tier = 0; tier < 4; tier++) {
        const top = 2 + tier * 10;
        for (let y = 0; y < 14; y++)
          for (let x = 0; x < W; x++) {
            const half = (y / 14) * (7 + tier * 2.5);
            if (Math.abs(x - 16) <= half && top + y < H) px(x, top + y, r() < 0.15 ? '#1f6b3a' : '#2e8b57');
          }
      }
      break;
    case 'bush':
      disc(16, 12, 9, '#4caf50', '#7ddf80');
      disc(7, 14, 6, '#4caf50', '#7ddf80');
      disc(25, 14, 6, '#4caf50', '#7ddf80');
      for (let i = 0; i < 6; i++) px(4 + r() * 24, 8 + r() * 10, '#ff77aa');
      break;
    case 'flower':
      for (let i = 0; i < 4; i++) {
        const x = 3 + i * 6;
        rect(x + 1, 8, 1, 8, '#3f9b3a');
        const col = ['#ff5b5b', '#ffd23f', '#ff77aa', '#a77bff'][i];
        rect(x, 5, 3, 3, col);
        px(x + 1, 6, '#fff7b0');
      }
      break;
    case 'rock':
      disc(12, 12, 9, '#8c8f96', '#5f636b');
      disc(6, 13, 5, '#8c8f96', '#5f636b');
      break;
    case 'cloud':
      disc(14, 12, 8, '#ffffff', '#e8f4ff');
      disc(26, 9, 9, '#ffffff', '#e8f4ff');
      disc(36, 13, 7, '#ffffff', '#e8f4ff');
      rect(10, 12, 32, 6, '#ffffff');
      break;
    case 'sun':
      disc(16, 16, 10, '#ffd23f', '#ffe680');
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        for (let d = 12; d < 15; d++) px(16 + Math.cos(a) * d, 16 + Math.sin(a) * d, '#ffb020');
      }
      px(12, 14, '#7a4a1f');
      px(20, 14, '#7a4a1f');
      rect(13, 19, 6, 1, '#7a4a1f');
      break;
    case 'castle':
      rect(0, 24, 96, 48, '#8c8f96');
      for (let x = 0; x < 96; x += 8) rect(x, 16, 4, 8, '#8c8f96');
      rect(8, 4, 20, 68, '#7a7d84');
      rect(68, 4, 20, 68, '#7a7d84');
      for (let x = 8; x < 28; x += 6) rect(x, 0, 3, 4, '#7a7d84');
      for (let x = 68; x < 88; x += 6) rect(x, 0, 3, 4, '#7a7d84');
      rect(40, 44, 16, 28, '#4a3320');
      for (let i = 0; i < 40; i++) px(r() * 96, 24 + r() * 48, '#5f636b');
      rect(16, 20, 4, 6, '#2b3a55');
      rect(76, 20, 4, 6, '#2b3a55');
      rect(14, 0, 1, 6, '#5a3618');
      rect(15, 0, 5, 3, '#e14d4d');
      break;
    case 'volcano':
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const half = 12 + (y / H) * 44;
          if (Math.abs(x - 56) <= half) px(x, y, r() < 0.12 ? '#3a2f45' : y < 6 ? '#5b4a6a' : '#2a2333');
        }
      rect(50, 0, 12, 4, '#ff5a1f');
      for (let y = 4; y < 40; y++) {
        px(54 + Math.sin(y * 0.4) * 2, y, '#ff5a1f');
        px(55 + Math.sin(y * 0.4) * 2, y, '#ffd23f');
      }
      for (let i = 0; i < 12; i++) px(44 + r() * 24, r() * 10, '#ffd23f');
      break;
    case 'deadtree':
      rect(11, 14, 3, 26, '#3b2a20');
      rect(6, 10, 6, 2, '#3b2a20');
      rect(4, 6, 2, 5, '#3b2a20');
      rect(14, 8, 6, 2, '#3b2a20');
      rect(18, 3, 2, 6, '#3b2a20');
      rect(12, 4, 2, 10, '#3b2a20');
      break;
    case 'stars':
      for (let i = 0; i < 70; i++) {
        const x = r() * W;
        const y = r() * H;
        const bright = r() < 0.3;
        px(x, y, bright ? '#ffffff' : '#a8b8ff');
        if (bright && r() < 0.5) {
          px(x + 1, y, '#dfe6ff');
          px(x - 1, y, '#dfe6ff');
          px(x, y + 1, '#dfe6ff');
          px(x, y - 1, '#dfe6ff');
        }
      }
      break;
    case 'earth':
      disc(16, 16, 13, '#2f6fd6', '#3d86f0');
      for (let i = 0; i < 6; i++) disc(6 + r() * 20, 6 + r() * 20, 2 + r() * 4, '#3fa34d', '#6fcf5c');
      for (let i = 0; i < 5; i++) disc(6 + r() * 20, 6 + r() * 20, 1 + r() * 2, '#ffffff');
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 16, y - 16) > 13) ctx.clearRect(x, y, 1, 1);
      break;
    case 'crater':
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const d = Math.hypot((x - 24) / 24, (y - 6) / 6);
          if (d > 0.8 && d < 1) px(x, y, '#b5b5c2');
          else if (d < 0.8 && r() < 0.35) px(x, y, '#6d6d7a');
        }
      break;
    case 'moonflag':
      rect(3, 2, 2, 30, '#d9d9d9');
      rect(5, 2, 12, 9, '#e14d4d');
      rect(5, 5, 12, 2, '#ffffff');
      rect(5, 2, 5, 5, '#2b3a9a');
      break;
  }
  const t = pixelTexture(c);
  cache.set(key, t);
  return t;
}

export function skyGradient(top: string, bottom: string): THREE.Texture {
  const key = 'sky:' + top + bottom;
  if (cache.has(key)) return cache.get(key)!;
  const { c, ctx } = makeCanvas(2, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}
