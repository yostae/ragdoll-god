import type { CreatureSpec, DecorDef, ItemDef, MaterialDef } from './types';

// Creature specs are the single source of truth shared with the Blender pipeline.
const specModules = import.meta.glob('../creatures/specs/*.json', { eager: true }) as Record<
  string,
  { default: CreatureSpec }
>;

export const CREATURES: Record<string, CreatureSpec> = {};
for (const mod of Object.values(specModules)) {
  const spec = mod.default;
  CREATURES[spec.id] = spec;
}
export const CREATURE_ORDER = ['knight', 'goblin', 'wolf', 'chicken'].filter((id) => CREATURES[id]);
for (const id of Object.keys(CREATURES)) if (!CREATURE_ORDER.includes(id)) CREATURE_ORDER.push(id);

export const MATERIALS: Record<string, MaterialDef> = {
  dirt: { id: 'dirt', name: 'Grass', color: '#6b4a2b', color2: '#5bb046', pattern: 'grass', density: 1500, friction: 0.9, restitution: 0.05, anchored: true },
  wood: { id: 'wood', name: 'Wood', color: '#b07a3c', color2: '#7d5323', pattern: 'planks', density: 500, friction: 0.7, restitution: 0.1, anchored: false },
  stone: { id: 'stone', name: 'Stone', color: '#8c8f96', color2: '#5f636b', pattern: 'stone', density: 2400, friction: 0.8, restitution: 0.05, anchored: true },
  brick: { id: 'brick', name: 'Brick', color: '#c4553d', color2: '#e0c9a6', pattern: 'bricks', density: 1800, friction: 0.8, restitution: 0.05, anchored: true },
  iron: { id: 'iron', name: 'Iron', color: '#7a8594', color2: '#3c434d', pattern: 'metal', density: 7800, friction: 0.5, restitution: 0.1, anchored: false },
  sand: { id: 'sand', name: 'Sand', color: '#e8cf86', color2: '#cbb069', pattern: 'sand', density: 1600, friction: 1.0, restitution: 0.0, anchored: true },
  ice: { id: 'ice', name: 'Ice', color: '#bfe9ff', color2: '#8fd0f5', pattern: 'ice', density: 900, friction: 0.02, restitution: 0.05, anchored: true },
  bouncy: { id: 'bouncy', name: 'Bouncy', color: '#ff6fb1', color2: '#ffb0d6', pattern: 'cloud', density: 300, friction: 0.6, restitution: 1.1, anchored: true },
  lava: { id: 'lava', name: 'Lava', color: '#ff5a1f', color2: '#ffd23f', pattern: 'lava', density: 2000, friction: 0.3, restitution: 0.0, anchored: true, hazard: 'lava', glow: '#ff3300' },
  obsidian: { id: 'obsidian', name: 'Obsidian', color: '#2a2333', color2: '#4b3f5e', pattern: 'stone', density: 2600, friction: 0.7, restitution: 0.05, anchored: true },
  moonrock: { id: 'moonrock', name: 'Moon Rock', color: '#9a9aa6', color2: '#6d6d7a', pattern: 'moon', density: 1400, friction: 0.9, restitution: 0.05, anchored: true },
  gold: { id: 'gold', name: 'Gold', color: '#ffc42e', color2: '#c98d0a', pattern: 'gold', density: 8000, friction: 0.4, restitution: 0.1, anchored: false, metal: 0.8 },
};
export const MATERIAL_ORDER = ['dirt', 'wood', 'stone', 'brick', 'iron', 'sand', 'ice', 'bouncy', 'lava', 'obsidian', 'moonrock', 'gold'];

export const ITEMS: Record<string, ItemDef> = {
  growWand: { id: 'growWand', name: 'Grow Wand', icon: '🪄', hint: 'Makes things BIGGER', size: [0.05, 0.35, 0.05], mass: 0.6, color: '#ffd23f', handleColor: '#7a4a1f', strike: 0.6 },
  shrinkWand: { id: 'shrinkWand', name: 'Shrink Wand', icon: '🔮', hint: 'Makes things smaller', size: [0.05, 0.35, 0.05], mass: 0.6, color: '#7fd1ff', handleColor: '#3c3c6e', strike: 0.6 },
  transmuteWand: { id: 'transmuteWand', name: 'Transmute Wand', icon: '✨', hint: 'Changes what blocks are made of', size: [0.05, 0.35, 0.05], mass: 0.6, color: '#c77dff', handleColor: '#4a2a5e', strike: 0.6 },
  bonkHammer: { id: 'bonkHammer', name: 'Bonk Hammer', icon: '🔨', hint: 'BONK. Big silly hits', size: [0.06, 0.4, 0.06], mass: 3, color: '#6e6e6e', handleColor: '#8b5a2b', strike: 2.5 },
  feather: { id: 'feather', name: 'Floaty Feather', icon: '🪶', hint: 'Makes things float like a balloon', size: [0.04, 0.3, 0.02], mass: 0.05, color: '#ffffff', handleColor: '#d9d9d9', strike: 0.2 },
  midasTouch: { id: 'midasTouch', name: 'Midas Touch', icon: '👑', hint: 'Turns anything into solid gold', size: [0.05, 0.3, 0.05], mass: 1.2, color: '#ffc42e', handleColor: '#7a4a1f', strike: 0.8 },
  mutationWand: { id: 'mutationWand', name: 'Mutation Wand', icon: '🧬', hint: 'Scrambles a creature: big heads, huge hands, tiny legs...', size: [0.05, 0.35, 0.05], mass: 0.6, color: '#7dff6b', handleColor: '#2f4a2a', strike: 0.6, pack: 'wizard' },
  bodyPotion: { id: 'bodyPotion', name: 'Body Part Potion', icon: '🧪', hint: 'Grows an extra arm, leg or wing!', size: [0.06, 0.12, 0.06], mass: 0.4, color: '#ff4fd8', handleColor: '#ffffff', strike: 0.4, pack: 'wizard' },
};
export const ITEM_ORDER = ['bonkHammer', 'growWand', 'shrinkWand', 'transmuteWand', 'feather', 'midasTouch', 'mutationWand', 'bodyPotion'];

export const DECOR: Record<string, DecorDef> = {
  tree: { id: 'tree', name: 'Tree', width: 2.4, height: 3.6, layer: -1 },
  pine: { id: 'pine', name: 'Pine', width: 2.0, height: 4.0, layer: -1 },
  bush: { id: 'bush', name: 'Bush', width: 1.4, height: 0.9, layer: 1 },
  cloud: { id: 'cloud', name: 'Cloud', width: 3.2, height: 1.4, layer: -3 },
  sun: { id: 'sun', name: 'Sun', width: 2.2, height: 2.2, layer: -4 },
  flower: { id: 'flower', name: 'Flowers', width: 0.9, height: 0.6, layer: 1 },
  rock: { id: 'rock', name: 'Rock', width: 1.2, height: 0.8, layer: -1 },
  castle: { id: 'castle', name: 'Castle backdrop', width: 8, height: 6, layer: -2 },
  volcano: { id: 'volcano', name: 'Volcano backdrop', width: 14, height: 9, layer: -2 },
  deadtree: { id: 'deadtree', name: 'Dead tree', width: 1.8, height: 3, layer: -1 },
  stars: { id: 'stars', name: 'Stars', width: 10, height: 6, layer: -5 },
  earth: { id: 'earth', name: 'Earth', width: 3, height: 3, layer: -4 },
  crater: { id: 'crater', name: 'Crater', width: 3, height: 0.8, layer: 1 },
  moonflag: { id: 'moonflag', name: 'Flag', width: 0.9, height: 1.6, layer: -1 },
};
export const DECOR_ORDER = ['tree', 'pine', 'bush', 'flower', 'rock', 'cloud', 'sun', 'castle', 'volcano', 'deadtree', 'stars', 'earth', 'crater', 'moonflag'];

export const HIT_WORDS = ['BONK!', 'POW!', 'WHAM!', 'BOINK!', 'THWACK!', 'OOF!', 'ZAP!'];
