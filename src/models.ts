import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group | null>>();

/** Load public/models/<id>.glb once; returns null when the model is missing (fallback meshes are used). */
export function loadCreatureModel(id: string): Promise<THREE.Group | null> {
  if (!cache.has(id)) {
    const p = new Promise<THREE.Group | null>((resolve) => {
      loader.load(
        `${import.meta.env.BASE_URL}models/${id}.glb`,
        (gltf) => {
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) {
              m.castShadow = true;
              m.receiveShadow = false;
              m.frustumCulled = false;
              const mats = Array.isArray(m.material) ? m.material : [m.material];
              for (const mat of mats) {
                const sm = mat as THREE.MeshStandardMaterial;
                if (sm.isMeshStandardMaterial) {
                  sm.roughness = 0.9;
                  sm.metalness = 0;
                }
              }
            }
          });
          resolve(gltf.scene);
        },
        undefined,
        () => resolve(null),
      );
    });
    cache.set(id, p);
  }
  return cache.get(id)!;
}

export function cloneModel(src: THREE.Group): THREE.Group {
  const c = skeletonClone(src) as THREE.Group;
  // Give each clone its own materials so tints don't leak between creatures.
  c.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
    }
  });
  return c;
}
