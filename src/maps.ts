import type { BlockData, MapData } from './types';

const ground = (x1: number, x2: number, top: number, depth = 3, material = 'dirt'): BlockData => ({
  material,
  x: (x1 + x2) / 2,
  y: top - depth / 2,
  w: x2 - x1,
  h: depth,
  anchored: true,
});

const box = (material: string, x: number, y: number, w: number, h: number, anchored?: boolean): BlockData => ({ material, x, y, w, h, anchored: anchored ?? (material !== 'wood' && material !== 'iron') });

export const PRESET_MAPS: MapData[] = [
  {
    name: 'Sunny Meadow',
    version: 1,
    gravity: 9.81,
    preset: true,
    sky: '#7ec8ff,#e6f7ff',
    camera: { x: 2, y: 3.5, zoom: 18 },
    blocks: [
      ground(-40, 40, 0, 4),
      // A gentle stepped hill on the right.
      ground(14, 40, 1, 1),
      ground(17, 40, 2, 1),
      ground(20, 40, 3, 1),
      // A little wooden stage held up by stone posts.
      box('stone', -9, 0.75, 0.5, 1.5),
      box('stone', -5, 0.75, 0.5, 1.5),
      box('wood', -7, 1.65, 5, 0.3, false),
      // A loose stack of crates to knock over.
      box('wood', 9, 0.5, 1, 1, false),
      box('wood', 9, 1.5, 1, 1, false),
      box('wood', 9, 2.5, 1, 1, false),
      box('iron', 9, 3.4, 0.8, 0.8, false),
    ],
    creatures: [
      { spec: 'knight', x: -3, y: 0, facing: 1, scale: 1 },
      { spec: 'goblin', x: 4, y: 0, facing: -1, scale: 1 },
      { spec: 'chicken', x: 12, y: 0, facing: -1, scale: 1 },
      { spec: 'wolf', x: 24, y: 3, facing: -1, scale: 1 },
    ],
    items: [{ kind: 'bonkHammer', x: -7, y: 2.3 }],
    decor: [
      { id: 'sun', x: -14, y: 9, scale: 1 },
      { id: 'cloud', x: -6, y: 8, scale: 1 },
      { id: 'cloud', x: 10, y: 9.5, scale: 1.3 },
      { id: 'cloud', x: 26, y: 8, scale: 0.9 },
      { id: 'tree', x: -14, y: 0, scale: 1.2 },
      { id: 'tree', x: -18, y: 0, scale: 0.9 },
      { id: 'pine', x: 30, y: 3, scale: 1.1 },
      { id: 'pine', x: 34, y: 3, scale: 1.3 },
      { id: 'bush', x: 1, y: 0, scale: 1 },
      { id: 'flower', x: -1, y: 0, scale: 1 },
      { id: 'flower', x: 6.5, y: 0, scale: 1 },
      { id: 'rock', x: 16, y: 1, scale: 1 },
    ],
  },
  {
    name: 'Castle Yard',
    version: 1,
    gravity: 9.81,
    preset: true,
    sky: '#5b7fd6,#cfd9ff',
    camera: { x: 0, y: 4, zoom: 20 },
    blocks: [
      ground(-40, 40, 0, 4, 'stone'),
      ground(-40, 40, 0.25, 0.25, 'dirt'),
      // Yard walls.
      box('brick', -12, 2, 1, 4),
      box('brick', 12, 2, 1, 4),
      // Battlements on the walls.
      box('brick', -12.25, 4.25, 0.5, 0.5),
      box('brick', 12.25, 4.25, 0.5, 0.5),
      // A brick tower with a loose wooden roof.
      box('brick', 0, 1.5, 1, 3),
      box('brick', 3, 1.5, 1, 3),
      box('wood', 1.5, 3.2, 4.5, 0.4, false),
      box('wood', 0.5, 3.9, 1, 1, false),
      box('wood', 2.5, 3.9, 1, 1, false),
      box('iron', 1.5, 4.9, 1, 1, false),
      // Ramps of sand to climb.
      box('sand', -7, 0.5, 2, 0.5),
      box('sand', -6, 1.0, 1, 0.5),
    ],
    creatures: [
      { spec: 'knight', x: -9, y: 0.25, facing: 1, scale: 1 },
      { spec: 'knight', x: -5, y: 0.25, facing: 1, scale: 1 },
      { spec: 'goblin', x: 6, y: 0.25, facing: -1, scale: 1 },
      { spec: 'goblin', x: 8, y: 0.25, facing: -1, scale: 1 },
      { spec: 'goblin', x: 10, y: 0.25, facing: -1, scale: 1.2 },
    ],
    items: [
      { kind: 'bonkHammer', x: -3, y: 0.6 },
      { kind: 'feather', x: 5, y: 0.6 },
    ],
    decor: [
      { id: 'castle', x: 0, y: 0.25, scale: 1.4 },
      { id: 'cloud', x: -16, y: 9, scale: 1 },
      { id: 'cloud', x: 18, y: 8, scale: 1.2 },
      { id: 'pine', x: -20, y: 0.25, scale: 1.2 },
      { id: 'pine', x: 20, y: 0.25, scale: 1.2 },
      { id: 'rock', x: -15, y: 0.25, scale: 1 },
    ],
  },
  {
    name: 'Icy Cliffs',
    version: 1,
    gravity: 9.81,
    preset: true,
    sky: '#9fd3ff,#ffffff',
    camera: { x: 0, y: 5, zoom: 22 },
    blocks: [
      // Left plateau, right plateau, deep gap with a bouncy pad at the bottom.
      ground(-40, -4, 4, 8, 'stone'),
      ground(-40, -4, 4.25, 0.25, 'ice'),
      ground(4, 40, 4, 8, 'stone'),
      ground(4, 40, 4.25, 0.25, 'dirt'),
      ground(-40, 40, -4, 4, 'stone'),
      box('bouncy', 0, -3.6, 8, 0.8),
      // Stepping stones across the gap (loose!).
      box('stone', -2, 4, 1.2, 0.4, false),
      box('stone', 0, 4.4, 1.2, 0.4, false),
      box('stone', 2, 4, 1.2, 0.4, false),
      // Ice ramp on the right.
      box('ice', 12, 4.6, 6, 0.5),
    ],
    creatures: [
      { spec: 'wolf', x: -12, y: 4.25, facing: 1, scale: 1 },
      { spec: 'chicken', x: -7, y: 4.25, facing: 1, scale: 1 },
      { spec: 'chicken', x: 8, y: 4.25, facing: -1, scale: 1 },
      { spec: 'chicken', x: 10, y: 4.25, facing: -1, scale: 0.8 },
      { spec: 'knight', x: 16, y: 4.25, facing: -1, scale: 1 },
    ],
    items: [
      { kind: 'growWand', x: -9, y: 4.8 },
      { kind: 'shrinkWand', x: 14, y: 4.8 },
    ],
    decor: [
      { id: 'sun', x: 12, y: 12, scale: 1 },
      { id: 'cloud', x: -10, y: 11, scale: 1.4 },
      { id: 'cloud', x: 4, y: 13, scale: 1 },
      { id: 'pine', x: -20, y: 4.25, scale: 1.4 },
      { id: 'pine', x: -24, y: 4.25, scale: 1.1 },
      { id: 'pine', x: 24, y: 4.25, scale: 1.3 },
      { id: 'rock', x: -6, y: 4.25, scale: 0.8 },
    ],
  },
  {
    name: 'Blank Canvas',
    version: 1,
    gravity: 9.81,
    preset: true,
    sky: '#7ec8ff,#e6f7ff',
    camera: { x: 0, y: 3, zoom: 18 },
    blocks: [ground(-40, 40, 0, 4)],
    creatures: [],
    items: [],
    decor: [{ id: 'sun', x: -12, y: 9, scale: 1 }],
  },
];
