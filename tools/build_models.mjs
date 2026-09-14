#!/usr/bin/env node
// Spawns Blender headless to build creature GLBs (and optional previews).
//   node tools/build_models.mjs [ids...] [--preview] [--no-export]
// Override the Blender binary with BLENDER_PATH if it is installed elsewhere.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "build_creatures.py");

const candidates = [
  process.env.BLENDER_PATH,
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
].filter(Boolean);
const blender = candidates.find((p) => existsSync(p)) ?? "blender";

const args = ["-b", "-P", script, "--", ...process.argv.slice(2)];
console.log(`> "${blender}" ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
const res = spawnSync(blender, args, { stdio: "inherit" });
if (res.error) {
  console.error(`Failed to launch Blender (${blender}): ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
