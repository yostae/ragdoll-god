# Ragdoll God

A sandbox ragdoll-physics God game for kids. Pick a world, build with materials, drop in
creatures and magic items, press Play, and watch the slapstick. Everything is a physics object:
creatures are active ragdolls that balance, walk, and bonk their natural enemies with whatever is
in their hands.

Runs in any modern browser (desktop or tablet). No install for players.

Live build: https://yostae.github.io/ragdoll-god/ (ask for the secret word). Every push to `main`
rebuilds and redeploys it through GitHub Pages; the hosted entry page is encrypted with the word
by `tools/gate.mjs`, using the `GATE_PASSWORD` repo secret.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173). `npm run build` produces a static
site in `dist/` that can be dropped on any static host.

## How to play

- **Maps** picks a preset world, one of your saved maps, or an imported `.json` map file.
- **Left panel** has four tabs:
  - Creatures: tap one, then tap the map to place it. Enemies fight on sight.
  - Materials: pick one, then drag a rectangle to build. Loose blocks tumble, pinned ones stay put.
    Scenery (trees, clouds, castle) is decoration only.
  - Items and weapons: **Place** drops the item on the map, drag it onto a creature to hand it
    over. **Use** lets you zap things yourself.
  - Mods: toggles unlocked by codes.
- **Tools** (bottom right): hand (grab, drag, fling), delete, pin/unpin, flip creature, camera
  home, pixel chunkiness.
- **Play / Pause / Reset** in the top bar. Reset returns to the moment you pressed Play.
- Camera: drag empty space or right-drag / two fingers to pan, scroll or pinch to zoom, WASD too.
- Keyboard: Space play/pause, R reset, H hand, X delete, P pin, F flip, Esc back to the hand.

Codes so far: `BIGHEAD`, `MOONWALK`, `SIZEMATTERS`, `PARTYTIME`.

## Architecture

- `src/physics.ts` Rapier 3D world wrapper. The game is plane-locked: every dynamic body gets a
  generic joint to a fixed anchor that removes Z translation and X/Y rotation (Rapier's built-in
  axis locks explode when combined with hinge joints, so this is done with joints).
- `src/creature.ts` Active ragdoll: one rigid body per spec part, hinge joints with limits and
  position motors, balance springs on the torso parts, gait animation, attack swings, a small
  brain (find enemy, walk, attack, wander) and the skinned-mesh binding.
- `src/game.ts` World state, modes, God tools (grab spring, item use), strike and impact damage,
  serialization.
- `src/input.ts` Pointer/touch/keyboard handling and tools. `src/ui.ts` all DOM chrome.
- `src/maps.ts` preset worlds. `src/mods.ts` codes and mods. `src/storage.ts` localStorage +
  JSON export/import. `src/sprites.ts` procedural pixel art (swap for Retro Diffusion PNGs later).
- `creatures/SPEC.md` + `creatures/specs/*.json` are the single source of truth for a creature:
  the runtime builds the ragdoll from them and Blender builds the mesh from them.

## Creature models (Blender)

```bash
npm run models:build     # headless Blender 5.2 -> public/models/<id>.glb
npm run models:preview   # side-view PNGs in public/models/preview/
npm run models:verify    # checks GLB bones/weights/bounds against the specs
```

`tools/build_creatures.py` reads the specs and generates a low-poly rigid-skinned mesh with one
bone per part. The runtime finds bones by part name, so any GLB that follows `creatures/SPEC.md`
(hand-modelled or generated) drops straight in.

## Tuning

`window.game` and `window.TUNE` are exposed in the browser console. `TUNE` holds the balance and
gait constants (hover spring, upright torque, motor multipliers, gait amplitude) and can be edited
live.

## Not yet

Sound and music, more creatures/materials/items, the next code packs, breakable materials, and a
real map editor beyond drag-to-build. Retro Diffusion art can replace the procedural sprites in
`src/sprites.ts` one texture at a time.
