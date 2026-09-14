// Shared data types. Creature specs follow creatures/SPEC.md exactly.

export type Vec3 = [number, number, number];

export interface PartJoint {
  anchor: Vec3;
  limits: [number, number]; // degrees
  stiffness?: number;
  damping?: number;
}

export interface PartSpec {
  name: string;
  parent: string | null;
  shape: 'box' | 'capsule' | 'sphere';
  pos: Vec3;
  rot?: Vec3; // degrees, only Z matters in a plane-locked world
  size: number[];
  mass: number;
  side?: 'L' | 'R';
  joint?: PartJoint;
  role?: 'head' | 'torso' | 'pelvis' | 'arm' | 'hand' | 'leg' | 'foot' | 'tail' | 'wing' | 'body';
}

export interface CreatureSpec {
  id: string;
  name: string;
  faction: string;
  enemies: string[];
  hp: number;
  walkSpeed: number;
  grip: string;
  eyeHeight: number;
  standHeight: number;
  root: string;
  palette?: Record<string, string>;
  enemyFactions?: string[];
  pack?: string; // undefined = base game; otherwise unlocked by a code pack
  icon?: string;
  blurb?: string;
  parts: PartSpec[];
}

export interface MaterialDef {
  id: string;
  name: string;
  color: string;
  color2: string;
  pattern: 'grass' | 'bricks' | 'planks' | 'stone' | 'metal' | 'sand' | 'ice' | 'cloud' | 'lava' | 'moon' | 'gold';
  hazard?: 'lava'; // touching it hurts and pops creatures out
  glow?: string; // emissive color
  metal?: number; // metalness 0..1
  density: number; // kg / m^3 (depth is 1 m)
  friction: number;
  restitution: number;
  anchored: boolean; // default pin state when placed
}

export type ItemKind = 'growWand' | 'shrinkWand' | 'transmuteWand' | 'bonkHammer' | 'feather' | 'mutationWand' | 'bodyPotion' | 'midasTouch';

export interface ItemDef {
  id: ItemKind;
  name: string;
  icon: string;
  hint: string;
  size: Vec3; // box half extents
  mass: number;
  color: string;
  handleColor: string;
  strike: number; // damage multiplier when swung
  pack?: string; // undefined = base game; otherwise unlocked by a code pack
}

export interface DecorDef {
  id: string;
  name: string;
  width: number;
  height: number;
  layer: number; // negative = behind the action, positive = in front
}

// ---------- Serialized map state ----------

export interface BlockData {
  material: string;
  x: number;
  y: number;
  w: number;
  h: number;
  anchored: boolean;
  rot?: number; // degrees
}

export interface CreatureData {
  spec: string;
  x: number;
  y: number;
  facing: 1 | -1;
  scale: number;
  item?: ItemKind;
  tint?: string;
  partScales?: Record<string, number>; // mutation wand results
  extraParts?: PartSpec[]; // body-part potion results
  statue?: boolean; // turned to gold
}

export interface ItemData {
  kind: ItemKind;
  x: number;
  y: number;
}

export interface DecorData {
  id: string;
  x: number;
  y: number;
  scale: number;
  layer?: number;
}

export interface MapData {
  name: string;
  version: 1;
  gravity: number;
  sky?: string;
  blocks: BlockData[];
  creatures: CreatureData[];
  items: ItemData[];
  decor: DecorData[];
  camera: { x: number; y: number; zoom: number };
  preset?: boolean;
}
