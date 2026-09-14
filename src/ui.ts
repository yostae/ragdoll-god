import type { Game, Mode } from './game';
import type { Input, Tool } from './input';
import { CREATURES, CREATURE_ORDER, DECOR, DECOR_ORDER, ITEMS, ITEM_ORDER, MATERIALS, MATERIAL_ORDER } from './data';
import { materialTexture } from './sprites';
import { PRESET_MAPS } from './maps';
import { storage, exportMap, importMap } from './storage';
import { lookupCode, unlockedMods, unlockedPacks, PACKS } from './mods';
import type { ItemKind, MapData } from './types';

const CREATURE_ICONS: Record<string, string> = { knight: '🛡️', goblin: '👺', wolf: '🐺', chicken: '🐔' };
const PRESET_ICONS: Record<string, string> = { 'Sunny Meadow': '🌻', 'Castle Yard': '🏰', 'Icy Cliffs': '🧊', 'Volcano Peak': '🌋', 'Moon Base': '🌙', 'Blank Canvas': '📄' };

type Tab = 'creatures' | 'materials' | 'items' | 'mods';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** All DOM chrome: top bar, side panels, tools, map picker, codes dialog. */
export class UI {
  root: HTMLElement;
  private tab: Tab = 'creatures';
  private panel!: HTMLElement;
  private tabsEl!: HTMLElement;
  private hint!: HTMLElement;
  private toastEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private mapNameEl!: HTMLElement;
  private overlay!: HTMLElement;
  private codesModal!: HTMLElement;
  private toolButtons = new Map<string, HTMLButtonElement>();
  private codes: string[] = storage.loadCodes();
  private settings = storage.loadSettings();
  private toastTimer = 0;
  private sidebarOpen = true;

  constructor(
    private game: Game,
    private input: Input,
  ) {
    this.root = document.getElementById('app')!;
    this.buildTopbar();
    this.buildSidebar();
    this.buildTools();
    this.hint = el('div', 'hint');
    this.root.appendChild(this.hint);
    this.toastEl = el('div', 'toast hidden');
    this.root.appendChild(this.toastEl);
    this.buildOverlay();
    this.buildCodesModal();

    game.onModeChange = (m) => this.onMode(m);
    game.onToast = (msg) => this.toast(msg);
    input.onToolChange = (t) => this.onTool(t);
    this.onTool(input.tool);
    this.onMode(game.mode);
    game.setActiveMods(this.settings.activeMods.filter((id) => unlockedMods(this.codes).some((m) => m.id === id)));
    game.setPacks(unlockedPacks(this.codes).map((p) => p.id));
    this.renderPanel();
    this.showMapPicker();
    if (window.innerWidth < 800) this.toggleSidebar(false);
  }

  // ---------- top bar ----------

  private buildTopbar() {
    const bar = el('div', 'topbar');
    const menu = el('button', 'btn', '🗺️ <span class="lbl">Maps</span>');
    menu.onclick = () => this.showMapPicker();
    this.mapNameEl = el('span', 'map-name', this.game.map.name);
    this.playBtn = el('button', 'btn play', '▶ Play');
    this.playBtn.onclick = () => this.game.togglePlay();
    const reset = el('button', 'btn', '↺ <span class="lbl">Reset</span>');
    reset.onclick = () => this.game.reset();
    const codes = el('button', 'btn', '🔑 <span class="lbl">Codes</span>');
    codes.onclick = () => this.codesModal.classList.remove('hidden');
    const save = el('button', 'btn', '💾 <span class="lbl">Save</span>');
    save.onclick = () => this.saveMap();
    bar.append(menu, this.mapNameEl, el('div', 'spacer'), this.playBtn, reset, el('div', 'spacer'), codes, save);
    this.root.appendChild(bar);
  }

  private onMode(m: Mode) {
    this.playBtn.innerHTML = m === 'play' ? '⏸ Pause' : m === 'pause' ? '▶ Resume' : '▶ Play';
    this.playBtn.classList.toggle('playing', m === 'play');
    document.body.dataset.mode = m;
  }

  // ---------- sidebar ----------

  private buildSidebar() {
    const side = el('div', 'sidebar');
    this.tabsEl = el('div', 'tabs');
    const tabs: [Tab, string][] = [
      ['creatures', '🧍'],
      ['materials', '🧱'],
      ['items', '🪄'],
      ['mods', '🎛️'],
    ];
    for (const [id, icon] of tabs) {
      const b = el('button', 'tab', `${icon}<small>${id}</small>`);
      b.dataset.tab = id;
      b.onclick = () => {
        this.tab = id;
        this.renderPanel();
        this.toggleSidebar(true);
      };
      this.tabsEl.appendChild(b);
    }
    this.panel = el('div', 'panel');
    side.append(this.tabsEl, this.panel);
    this.root.appendChild(side);
    const toggle = el('button', 'btn sidebar-toggle', '◀');
    toggle.onclick = () => this.toggleSidebar(!this.sidebarOpen);
    this.root.appendChild(toggle);
    this.renderPanel();
  }

  private toggleSidebar(open: boolean) {
    this.sidebarOpen = open;
    this.root.classList.toggle('sidebar-closed', !open);
    (this.root.querySelector('.sidebar-toggle') as HTMLElement).textContent = open ? '◀' : '▶';
  }

  private renderPanel() {
    this.tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === this.tab));
    this.panel.innerHTML = '';
    const cardDrag = (card: HTMLElement, tool: Tool) => {
      card.addEventListener('pointerdown', (e) => {
        this.input.setTool(tool);
        if (e.pointerType === 'touch') return;
        // Mouse/pen: allow dragging straight onto the map.
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointerup', up);
          const target = document.elementFromPoint(ev.clientX, ev.clientY);
          if (target === this.game.renderer.canvas) {
            const evt = new PointerEvent('pointerdown', { clientX: ev.clientX, clientY: ev.clientY, pointerId: ev.pointerId + 1000, pointerType: 'mouse', button: 0, bubbles: true });
            this.game.renderer.canvas.dispatchEvent(evt);
            const evt2 = new PointerEvent('pointerup', { clientX: ev.clientX, clientY: ev.clientY, pointerId: ev.pointerId + 1000, pointerType: 'mouse', button: 0, bubbles: true });
            this.game.renderer.canvas.dispatchEvent(evt2);
          }
        };
        window.addEventListener('pointerup', up);
      });
    };
    if (this.tab === 'creatures') {
      this.panel.appendChild(el('h3', undefined, 'Creatures'));
      this.panel.appendChild(el('p', 'help', 'Tap a creature, then tap the map to drop it in. Enemies fight on sight!'));
      const unlocked = new Set(this.game.packs);
      const groups: Array<{ title: string | null; ids: string[] }> = [{ title: null, ids: CREATURE_ORDER.filter((id) => !CREATURES[id].pack) }];
      for (const packId of Object.keys(PACKS)) {
        if (!unlocked.has(packId)) continue;
        const ids = CREATURE_ORDER.filter((id) => CREATURES[id].pack === packId);
        if (ids.length) groups.push({ title: `${PACKS[packId].icon} ${PACKS[packId].name}`, ids });
      }
      for (const g of groups) {
        if (g.title) this.panel.appendChild(el('h3', undefined, g.title));
        const grid = el('div', 'grid');
        for (const id of g.ids) {
          const spec = CREATURES[id];
          const sub = spec.blurb ?? `fights ${spec.enemies.map((e) => CREATURES[e]?.name ?? e).join(', ')}`;
          const card = el('button', 'card', `<span class="icon">${spec.icon ?? CREATURE_ICONS[id] ?? '🧬'}</span><span class="name">${spec.name}</span><small>${sub}</small>`);
          card.dataset.tool = `place:creature:${id}`;
          cardDrag(card, { type: 'place', kind: 'creature', id });
          grid.appendChild(card);
        }
        this.panel.appendChild(grid);
      }
      const lockedCount = CREATURE_ORDER.filter((id) => CREATURES[id].pack && !unlocked.has(CREATURES[id].pack!)).length;
      if (lockedCount) this.panel.appendChild(el('p', 'help', `🔒 ${lockedCount} more creatures are hiding behind secret codes.`));
    } else if (this.tab === 'materials') {
      this.panel.appendChild(el('h3', undefined, 'Materials'));
      this.panel.appendChild(el('p', 'help', 'Pick one, then drag a rectangle on the map. Loose blocks tumble; use 📌 to pin or unpin.'));
      const grid = el('div', 'grid');
      for (const id of MATERIAL_ORDER) {
        const m = MATERIALS[id];
        const card = el('button', 'card mat', `<span class="swatch"></span><span class="name">${m.name}</span><small>${m.anchored ? 'pinned' : 'loose'} · ${m.density >= 2000 ? 'heavy' : m.density >= 1000 ? 'medium' : 'light'}</small>`);
        const sw = card.querySelector('.swatch') as HTMLElement;
        sw.style.backgroundImage = `url(${(materialTexture(m).image as HTMLCanvasElement).toDataURL()})`;
        card.dataset.tool = `material:${id}`;
        card.onclick = () => this.input.setTool({ type: 'material', id });
        grid.appendChild(card);
      }
      this.panel.appendChild(grid);
      this.panel.appendChild(el('h3', undefined, 'Scenery'));
      this.panel.appendChild(el('p', 'help', 'Decoration only. Nothing bumps into it.'));
      const dgrid = el('div', 'grid');
      const icons: Record<string, string> = { tree: '🌳', pine: '🌲', bush: '🌿', flower: '🌼', rock: '🪨', cloud: '☁️', sun: '☀️', castle: '🏰' };
      for (const id of DECOR_ORDER) {
        const d = DECOR[id];
        const card = el('button', 'card', `<span class="icon">${icons[id] ?? '🎨'}</span><span class="name">${d.name}</span>`);
        card.dataset.tool = `place:decor:${id}`;
        cardDrag(card, { type: 'place', kind: 'decor', id });
        dgrid.appendChild(card);
      }
      this.panel.appendChild(dgrid);
    } else if (this.tab === 'items') {
      this.panel.appendChild(el('h3', undefined, 'Items & Weapons'));
      this.panel.appendChild(el('p', 'help', 'Tap an item, then tap a creature or block to use it on them. <b>Drop</b> puts the item on the map so creatures can grab it.'));
      const list = el('div', 'list');
      const unlockedI = new Set(this.game.packs);
      const lockedItems = ITEM_ORDER.filter((id) => ITEMS[id].pack && !unlockedI.has(ITEMS[id].pack!)).length;
      for (const id of ITEM_ORDER) {
        const it = ITEMS[id];
        if (it.pack && !unlockedI.has(it.pack)) continue;
        const row = el('div', 'item-row');
        const use = el('button', 'card', `<span class="icon">${it.icon}</span><span class="name">${it.name}</span><small>${it.hint}</small>`);
        use.dataset.tool = `use:${id}`;
        use.onclick = () => this.input.setTool({ type: 'use', kind: id as ItemKind });
        const drop = el('button', 'btn drop', '⬇ Drop');
        drop.dataset.tool = `place:item:${id}`;
        cardDrag(drop, { type: 'place', kind: 'item', id });
        row.append(use, drop);
        list.appendChild(row);
      }
      this.panel.appendChild(list);
      if (lockedItems) this.panel.appendChild(el('p', 'help', `🔒 ${lockedItems} more items are hiding behind secret codes.`));
    } else {
      this.panel.appendChild(el('h3', undefined, 'Mods'));
      const mods = unlockedMods(this.codes);
      if (!mods.length) {
        this.panel.appendChild(el('p', 'help', 'No mods yet. Enter a secret code with the 🔑 Codes button to unlock some!'));
      } else {
        this.panel.appendChild(el('p', 'help', 'Toggle mods on and off. Size and color mods apply to creatures you place next.'));
      }
      const list = el('div', 'list');
      for (const m of mods) {
        const on = this.game.activeMods.includes(m.id);
        const row = el('button', 'card mod' + (on ? ' on' : ''), `<span class="icon">${m.icon}</span><span class="name">${m.name}</span><small>${m.description}</small><span class="switch">${on ? 'ON' : 'OFF'}</span>`);
        row.onclick = () => {
          const active = on ? this.game.activeMods.filter((x) => x !== m.id) : [...this.game.activeMods, m.id];
          this.game.setActiveMods(active);
          this.settings.activeMods = active;
          storage.saveSettings(this.settings);
          this.renderPanel();
        };
        list.appendChild(row);
      }
      this.panel.appendChild(list);
      const packs = unlockedPacks(this.codes);
      if (packs.length) {
        this.panel.appendChild(el('h3', undefined, 'Unlocked packs'));
        const plist = el('div', 'list');
        for (const p of packs) plist.appendChild(el('div', 'unlocked', `${p.icon} <b>${p.name}</b><br><small>${p.description}</small>`));
        this.panel.appendChild(plist);
      }
      const codeBtn = el('button', 'btn wide', '🔑 Enter a code');
      codeBtn.onclick = () => this.codesModal.classList.remove('hidden');
      this.panel.appendChild(codeBtn);
    }
    this.highlightTool(this.input.tool);
  }

  private toolKey(t: Tool): string {
    if (t.type === 'place') return `place:${t.kind}:${t.id}`;
    if (t.type === 'material') return `material:${t.id}`;
    if (t.type === 'use') return `use:${t.kind}`;
    return t.type;
  }

  private highlightTool(t: Tool) {
    const key = this.toolKey(t);
    this.root.querySelectorAll('[data-tool]').forEach((e) => e.classList.toggle('active', (e as HTMLElement).dataset.tool === key));
  }

  // ---------- tools ----------

  private buildTools() {
    const bar = el('div', 'tools');
    const mk = (key: string, label: string, title: string, onClick: () => void) => {
      const b = el('button', 'btn tool', label);
      b.title = title;
      b.dataset.tool = key;
      b.onclick = onClick;
      bar.appendChild(b);
      this.toolButtons.set(key, b);
    };
    mk('hand', '✋', 'Hand: grab, drag and fling things (H)', () => this.input.setTool({ type: 'hand' }));
    mk('delete', '🗑️', 'Delete: tap something to remove it (X)', () => this.input.setTool({ type: 'delete' }));
    mk('pin', '📌', 'Pin: tap a block to pin or unpin it (P)', () => this.input.setTool({ type: 'pin' }));
    mk('flip', '🔄', 'Flip: turn a creature around (F)', () => this.input.setTool({ type: 'flip' }));
    const home = el('button', 'btn tool', '🎯');
    home.title = 'Camera back to the map start';
    home.onclick = () => {
      this.game.renderer.target.set(this.game.map.camera.x, this.game.map.camera.y);
      this.game.renderer.zoom = this.game.map.camera.zoom;
    };
    bar.appendChild(home);
    const px = el('button', 'btn tool', '🟪');
    px.title = 'Pixel chunkiness';
    px.onclick = () => {
      const next = this.settings.pixelSize >= 4 ? 1 : this.settings.pixelSize + 1;
      this.settings.pixelSize = next;
      storage.saveSettings(this.settings);
      this.game.renderer.setPixelSize(next);
      this.toast(`Pixel size ${next}`);
    };
    bar.appendChild(px);
    this.root.appendChild(bar);
  }

  private onTool(t: Tool) {
    this.highlightTool(t);
    const hints: Record<Tool['type'], string> = {
      hand: 'Drag things around. Press Play and fling creatures! Right-drag or two fingers to pan, scroll or pinch to zoom.',
      delete: 'Tap anything to delete it. Esc to stop.',
      pin: 'Tap a block to pin it in place or set it loose.',
      flip: 'Tap a creature to turn it around.',
      place: 'Tap the map to place. Keep tapping for more. Esc or ✋ to stop.',
      material: 'Drag a rectangle on the map to build. Tap for a 1×1 block.',
      use: 'Tap a creature, block or item to use it on them.',
    };
    let text = hints[t.type];
    if (t.type === 'place') text = `Placing ${t.kind === 'creature' ? CREATURES[t.id]?.name : t.kind === 'item' ? ITEMS[t.id]?.name : DECOR[t.id]?.name}: ` + text;
    if (t.type === 'material') text = `Building with ${MATERIALS[t.id]?.name}: ` + text;
    if (t.type === 'use') text = `Using ${ITEMS[t.kind]?.name}: ` + text;
    this.hint.textContent = text;
  }

  // ---------- toast ----------

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), 2200);
  }

  // ---------- map picker ----------

  private buildOverlay() {
    this.overlay = el('div', 'modal hidden');
    this.root.appendChild(this.overlay);
  }

  showMapPicker() {
    const o = this.overlay;
    o.innerHTML = '';
    const box = el('div', 'modal-box');
    box.appendChild(el('h1', undefined, '🌍 Ragdoll God'));
    box.appendChild(el('p', 'help', 'Pick a world to play in. Build, drop in creatures, press Play, and watch the chaos.'));
    box.appendChild(el('h3', undefined, 'Worlds'));
    const grid = el('div', 'grid maps');
    for (const m of PRESET_MAPS) {
      const c = el('button', 'card map', `<span class="icon">${PRESET_ICONS[m.name] ?? '🗺️'}</span><span class="name">${m.name}</span><small>${m.creatures.length} creatures · ${m.blocks.length} blocks</small>`);
      c.onclick = () => this.openMap(m);
      grid.appendChild(c);
    }
    box.appendChild(grid);
    const saved = storage.loadMaps();
    const names = Object.keys(saved).sort();
    box.appendChild(el('h3', undefined, 'My Maps'));
    if (!names.length) box.appendChild(el('p', 'help', 'Nothing saved yet. Build something and press 💾 Save.'));
    const sgrid = el('div', 'grid maps');
    for (const n of names) {
      const m = saved[n];
      const c = el('button', 'card map', `<span class="icon">💾</span><span class="name">${n}</span><small>${m.creatures.length} creatures · ${m.blocks.length} blocks</small>`);
      c.onclick = () => this.openMap(m);
      const del = el('button', 'btn tiny', '✕');
      del.title = 'Delete this map';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${n}"?`)) {
          storage.deleteMap(n);
          this.showMapPicker();
        }
      };
      c.appendChild(del);
      sgrid.appendChild(c);
    }
    box.appendChild(sgrid);
    const row = el('div', 'row');
    const imp = el('button', 'btn', '📂 Import map file');
    imp.onclick = async () => {
      const m = await importMap();
      if (m) this.openMap(m);
      else this.toast('That file is not a map.');
    };
    row.appendChild(imp);
    if (this.game.blocks.length) {
      const back = el('button', 'btn', '← Back to the game');
      back.onclick = () => o.classList.add('hidden');
      row.appendChild(back);
    }
    box.appendChild(row);
    o.appendChild(box);
    o.classList.remove('hidden');
  }

  private openMap(m: MapData) {
    this.game.loadMap(JSON.parse(JSON.stringify(m)));
    this.mapNameEl.textContent = m.name;
    this.overlay.classList.add('hidden');
    this.input.setTool({ type: 'hand' });
  }

  private saveMap() {
    const current = this.game.map.name;
    const suggested = this.game.map.preset ? `My ${current}` : current;
    const name = prompt('Name your map:', suggested);
    if (!name) return;
    const data = this.game.serialize(name.trim());
    storage.saveMap(data);
    this.game.map = { ...this.game.map, name: data.name, preset: false };
    this.mapNameEl.textContent = data.name;
    this.toast(`Saved "${data.name}"`);
    if (confirm('Also download it as a file to share?')) exportMap(data);
  }

  // ---------- codes ----------

  private buildCodesModal() {
    const m = el('div', 'modal hidden');
    const box = el('div', 'modal-box small');
    box.appendChild(el('h2', undefined, '🔑 Secret Codes'));
    box.appendChild(el('p', 'help', 'Type a code to unlock a mod pack. Unlocked mods live in the 🎛️ Mods panel.'));
    const row = el('div', 'row');
    const inp = el('input');
    inp.placeholder = 'ENTER CODE';
    inp.autocapitalize = 'characters';
    const go = el('button', 'btn play', 'Unlock');
    row.append(inp, go);
    box.appendChild(row);
    const msg = el('p', 'msg');
    box.appendChild(msg);
    const list = el('div', 'list');
    box.appendChild(list);
    const refresh = () => {
      list.innerHTML = '';
      for (const c of this.codes) {
        const def = lookupCode(c);
        if (def) list.appendChild(el('div', 'unlocked', `✅ <b>${def.title}</b> <small>${def.code}</small>`));
      }
    };
    const submit = () => {
      const def = lookupCode(inp.value);
      if (!def) {
        msg.textContent = 'Hmm, that is not a code. Try again!';
        return;
      }
      if (!this.codes.includes(def.code)) {
        this.codes.push(def.code);
        storage.saveCodes(this.codes);
      }
      const packNames = (def.packs ?? []).map((p) => PACKS[p]?.name).filter(Boolean);
      msg.textContent = `Unlocked the ${def.title}!` + (packNames.length ? ` New stuff in the panels.` : '');
      inp.value = '';
      this.game.setPacks(unlockedPacks(this.codes).map((p) => p.id));
      refresh();
      this.renderPanel();
    };
    go.onclick = submit;
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
    const close = el('button', 'btn wide', 'Done');
    close.onclick = () => m.classList.add('hidden');
    box.appendChild(close);
    m.appendChild(box);
    this.root.appendChild(m);
    this.codesModal = m;
    refresh();
  }
}
