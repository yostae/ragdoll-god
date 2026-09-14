// Codes unlock mod packs. A mod tweaks world settings or how creatures spawn.
// Enter a code in the Codes dialog; unlocked mods show up as toggles in the Mods panel.

export interface ModContext {
  gravity: number; // multiplier on the map's gravity
  creatureScale: number; // multiplier applied to newly placed creatures
  headScale: number; // multiplier on head size for newly placed creatures
  rainbow: boolean; // random tint on newly placed creatures
  bouncyWorld: boolean; // every block becomes bouncy
  slowMo: number; // time scale
}

export interface ModDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  apply(ctx: ModContext): void;
}

export interface CodeDef {
  code: string;
  title: string;
  mods: string[];
}

export const MODS: Record<string, ModDef> = {
  bighead: { id: 'bighead', name: 'Big Heads', icon: '🗿', description: 'Everyone gets an enormous noggin.', apply: (c) => (c.headScale *= 2) },
  moon: { id: 'moon', name: 'Moon Gravity', icon: '🌙', description: 'Everything floats and falls slowly.', apply: (c) => (c.gravity *= 0.18) },
  tiny: { id: 'tiny', name: 'Tiny Town', icon: '🐜', description: 'New creatures are half size.', apply: (c) => (c.creatureScale *= 0.5) },
  giants: { id: 'giants', name: 'Giants', icon: '🦣', description: 'New creatures are double size.', apply: (c) => (c.creatureScale *= 2) },
  rainbow: { id: 'rainbow', name: 'Rainbow Crew', icon: '🌈', description: 'New creatures come in random colors.', apply: (c) => (c.rainbow = true) },
  trampoline: { id: 'trampoline', name: 'Trampoline World', icon: '🤸', description: 'Every block is bouncy.', apply: (c) => (c.bouncyWorld = true) },
  slowmo: { id: 'slowmo', name: 'Slow-Mo', icon: '🐢', description: 'Time runs at half speed.', apply: (c) => (c.slowMo *= 0.5) },
};

// The first code pack. More packs get designed once the core game is fun.
export const CODES: CodeDef[] = [
  { code: 'BIGHEAD', title: 'Noggin Pack', mods: ['bighead'] },
  { code: 'MOONWALK', title: 'Space Pack', mods: ['moon', 'slowmo'] },
  { code: 'SIZEMATTERS', title: 'Size Pack', mods: ['tiny', 'giants'] },
  { code: 'PARTYTIME', title: 'Party Pack', mods: ['rainbow', 'trampoline'] },
];

export function defaultModContext(): ModContext {
  return { gravity: 1, creatureScale: 1, headScale: 1, rainbow: false, bouncyWorld: false, slowMo: 1 };
}

export function buildModContext(activeMods: string[]): ModContext {
  const ctx = defaultModContext();
  for (const id of activeMods) MODS[id]?.apply(ctx);
  return ctx;
}

export function unlockedMods(codes: string[]): ModDef[] {
  const ids = new Set<string>();
  for (const c of codes) CODES.find((d) => d.code === c)?.mods.forEach((m) => ids.add(m));
  return [...ids].map((id) => MODS[id]).filter(Boolean);
}

export function lookupCode(input: string): CodeDef | null {
  const norm = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODES.find((c) => c.code === norm) ?? null;
}
