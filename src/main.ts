import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './game';
import { Input } from './input';
import { UI } from './ui';
import { PRESET_MAPS } from './maps';
import { storage } from './storage';
import './style.css';

async function boot() {
  await RAPIER.init();
  const viewport = document.getElementById('viewport')!;
  const game = new Game(viewport, JSON.parse(JSON.stringify(PRESET_MAPS[0])));
  game.renderer.setPixelSize(storage.loadSettings().pixelSize);
  const input = new Input(game, game.renderer.canvas);
  const ui = new UI(game, input);
  (window as unknown as { game: Game; RAPIER: typeof RAPIER }).game = game; // handy for debugging in the console
  (window as unknown as { RAPIER: typeof RAPIER }).RAPIER = RAPIER;

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    input.update(dt);
    game.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  void ui;
  document.getElementById('loading')?.remove();
}

boot().catch((err) => {
  console.error(err);
  const l = document.getElementById('loading');
  if (l) l.textContent = 'Something went wrong starting the game: ' + (err as Error).message;
});
