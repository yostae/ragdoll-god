import * as THREE from 'three';
import type { DecorData, DecorDef } from './types';
import { DECOR } from './data';
import { decorTexture } from './sprites';

let nextId = 1;

/** Non-physical 2D scenery: trees, clouds, backdrops. Layer decides depth (negative = behind). */
export class Decor {
  id = nextId++;
  def: DecorDef;
  mesh: THREE.Mesh;
  scale: number;
  layer: number;

  constructor(
    private scene: THREE.Scene,
    defId: string,
    public x: number,
    public y: number,
    scale = 1,
    layer?: number,
  ) {
    this.def = DECOR[defId] ?? DECOR.bush;
    this.scale = scale;
    this.layer = layer ?? this.def.layer;
    const mat = new THREE.MeshBasicMaterial({ map: decorTexture(this.def.id), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.def.width, this.def.height), mat);
    this.mesh.userData.decor = this;
    this.scene.add(this.mesh);
    this.update();
  }

  update() {
    this.mesh.scale.set(this.scale, this.scale, 1);
    this.mesh.position.set(this.x, this.y + (this.def.height * this.scale) / 2, this.layer * 1.4);
  }

  translate(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.update();
  }

  serialize(): DecorData {
    return { id: this.def.id, x: +this.x.toFixed(2), y: +this.y.toFixed(2), scale: this.scale, layer: this.layer !== this.def.layer ? this.layer : undefined };
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
