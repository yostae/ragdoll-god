import * as THREE from 'three';
import { skyGradient } from './sprites';

/** Three.js scene, side-scroller camera and a chunky-pixel renderer. */
export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  pixelSize = 3;
  target = new THREE.Vector2(0, 4);
  zoom = 18; // camera distance
  minZoom = 4;
  maxZoom = 80;
  private sky: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  shake = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    this.camera.position.set(0, 4, this.zoom);

    const hemi = new THREE.HemisphereLight(0xdfefff, 0x6b8a4a, 1.1);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
    this.sun.position.set(6, 14, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -30;
    this.sun.shadow.camera.right = 30;
    this.sun.shadow.camera.top = 30;
    this.sun.shadow.camera.bottom = -30;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 80;
    this.sun.shadow.bias = -0.0015;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Sky: a big quad far behind the action, gradient texture.
    const skyGeo = new THREE.PlaneGeometry(1, 1);
    const skyMat = new THREE.MeshBasicMaterial({ map: skyGradient('#7ec8ff', '#dff4ff'), depthWrite: false });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setSky(top: string, bottom: string) {
    (this.sky.material as THREE.MeshBasicMaterial).map = skyGradient(top, bottom);
    (this.sky.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }

  resize() {
    const w = this.canvas.parentElement?.clientWidth || window.innerWidth;
    const h = this.canvas.parentElement?.clientHeight || window.innerHeight;
    this.renderer.setSize(Math.max(1, Math.floor(w / this.pixelSize)), Math.max(1, Math.floor(h / this.pixelSize)), false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPixelSize(px: number) {
    this.pixelSize = Math.max(1, Math.min(6, px));
    this.resize();
  }

  /** Width of the visible world at the z = 0 plane. */
  viewWidth() {
    return 2 * this.zoom * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
  }

  /** Convert a client-space pointer position to a world point on the z = 0 plane. */
  screenToWorld(clientX: number, clientY: number, z = 0): THREE.Vector3 {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5);
    ndc.unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    const t = (z - this.camera.position.z) / dir.z;
    return this.camera.position.clone().add(dir.multiplyScalar(t));
  }

  raycaster(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  render(dt: number) {
    let sx = 0,
      sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
    this.camera.position.set(this.target.x + sx, this.target.y + sy, this.zoom);
    this.camera.lookAt(this.target.x + sx, this.target.y + sy, 0);
    this.sun.position.set(this.target.x + 6, this.target.y + 14, 12);
    this.sun.target.position.set(this.target.x, this.target.y, 0);
    // Keep the sky quad filling the view far behind the scene.
    const skyZ = -60;
    const dist = this.zoom - skyZ;
    const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
    this.sky.scale.set(h * this.camera.aspect, h, 1);
    this.sky.position.set(this.target.x, this.target.y + 6, skyZ);
    this.renderer.render(this.scene, this.camera);
  }
}
