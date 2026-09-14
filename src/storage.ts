import type { MapData } from './types';

const MAPS_KEY = 'ragdoll-god:maps';
const CODES_KEY = 'ragdoll-god:codes';
const SETTINGS_KEY = 'ragdoll-god:settings';

export interface Settings {
  pixelSize: number;
  activeMods: string[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full: ignore */
  }
}

export const storage = {
  loadMaps(): Record<string, MapData> {
    return read(MAPS_KEY, {});
  },
  saveMap(map: MapData) {
    const maps = storage.loadMaps();
    maps[map.name] = map;
    write(MAPS_KEY, maps);
  },
  deleteMap(name: string) {
    const maps = storage.loadMaps();
    delete maps[name];
    write(MAPS_KEY, maps);
  },
  loadCodes(): string[] {
    return read(CODES_KEY, []);
  },
  saveCodes(codes: string[]) {
    write(CODES_KEY, codes);
  },
  loadSettings(): Settings {
    return { pixelSize: 3, activeMods: [], ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
  },
  saveSettings(s: Settings) {
    write(SETTINGS_KEY, s);
  },
};

/** Trigger a JSON download of a map. */
export function exportMap(map: MapData) {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${map.name.replace(/[^a-z0-9_-]+/gi, '_') || 'map'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function importMap(): Promise<MapData | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        const data = JSON.parse(await f.text()) as MapData;
        if (!data || !Array.isArray(data.blocks)) return resolve(null);
        data.creatures ??= [];
        data.items ??= [];
        data.decor ??= [];
        data.camera ??= { x: 0, y: 4, zoom: 18 };
        data.gravity ??= 9.81;
        data.preset = false;
        resolve(data);
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}
