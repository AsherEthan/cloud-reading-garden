import * as THREE from 'three';
import { POINTS, SPAWN, WIDTH, HEIGHT, waterAt, type Position } from '../../shared/world.mjs';
import type { WorldPlayer } from '../types';

export const OUTFITS = ['#bb7253', '#658eb1', '#9780b1', '#d8ac4d', '#638b65', '#c77d9c'];

export type WorldView = {
  resize: (width: number, height: number) => void;
  render: (players: WorldPlayer[], selfId: string, time: number, reduced: boolean) => void;
  pick: (clientX: number, clientY: number) => { position: Position; placeId?: string } | null;
  setDestination: (position: Position | null) => void;
  dispose: () => void;
};

type Avatar = {
  root: THREE.Group;
  body: THREE.Mesh;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  label: THREE.Sprite;
  emote: THREE.Sprite;
  ring: THREE.Mesh;
  name: string;
  expression: string;
};

const hash = (x: number, y: number) => Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1;
const facingAngles: Record<string, number> = {
  down: 0,
  right: Math.PI / 2,
  up: Math.PI,
  left: -Math.PI / 2,
};

// 地图格仍由服务端共享规则决定；这里只负责立体呈现、相机和射线拾取。
export function createWorldRenderer(canvas: HTMLCanvasElement, preview = false): WorldView {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e6ecdc');
  scene.fog = new THREE.Fog('#e6ecdc', 75, 125);
  const camera = new THREE.OrthographicCamera(-24, 24, 17, -17, 0.1, 160);
  const target = new THREE.Vector3(24, 0, preview ? 16 : SPAWN.y - 1);
  const offset = new THREE.Vector3(20, 40, 30);
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const intersection = new THREE.Vector3();
  const pickables: THREE.Mesh[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const avatars = new Map<string, Avatar>();
  const palette = new Map<string, THREE.MeshStandardMaterial>();
  const batches = new Map<
    string,
    {
      geometry: THREE.BufferGeometry;
      material: THREE.MeshStandardMaterial;
      matrices: THREE.Matrix4[];
    }
  >();
  const dummy = new THREE.Object3D();
  let viewportWidth = 1;
  let viewportHeight = 1;
  let previousTime = 0;
  let frames = 0;
  let disposed = false;

  const ownGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.add(geometry);
    return geometry;
  };
  const cube = ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  const cylinder = ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  const foliage = ownGeometry(new THREE.IcosahedronGeometry(1, 0));
  const roof = ownGeometry(new THREE.BufferGeometry());
  roof.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0, 0.5, 0, -0.5,
        -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0, -0.5, 0, -0.5, -0.5, 0, 0.5,
        -0.5, 1, 0, 0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5,
        -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
      ],
      3,
    ),
  );
  roof.computeVertexNormals();

  const material = (color: string) => {
    let value = palette.get(color);
    if (!value) {
      value = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
      palette.set(color, value);
      materials.add(value);
    }
    return value;
  };
  const stamp = (
    geometry: THREE.BufferGeometry,
    color: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rotation = 0,
  ) => {
    const mat = material(color);
    const key = `${geometry.uuid}:${color}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { geometry, material: mat, matrices: [] };
      batches.set(key, batch);
    }
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotation, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    batch.matrices.push(dummy.matrix.clone());
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string) =>
    stamp(cube, color, x, y, z, w, h, d);
  const label = (text: string, width = 4.4, color = '#fff4d7') => {
    const image = document.createElement('canvas');
    const context = image.getContext('2d')!;
    const display = text.length > 12 ? `${text.slice(0, 11)}…` : text;
    const font = '600 32px "Microsoft YaHei", sans-serif';
    context.font = font;
    image.width = Math.ceil(context.measureText(display).width) + 36;
    image.height = 64;
    context.fillStyle = '#73583f';
    context.fillRect(0, 0, image.width, image.height);
    context.fillStyle = color;
    context.fillRect(3, 3, image.width - 6, image.height - 6);
    context.fillStyle = '#513c2d';
    context.font = font;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(display, image.width / 2, 34);
    const texture = new THREE.CanvasTexture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    materials.add(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(width, (width * image.height) / image.width, 1);
    return sprite;
  };
  const releaseLabel = (sprite: THREE.Sprite) => {
    const texture = sprite.material.map;
    if (texture) {
      texture.dispose();
      textures.delete(texture);
    }
    sprite.material.dispose();
    materials.delete(sprite.material);
  };
  const placeLabel = (text: string, x: number, y: number, z: number, width = 4.4) => {
    const sprite = label(text, width);
    sprite.position.set(x, y, z);
    scene.add(sprite);
  };
  const collider = (
    id: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ) => {
    const mesh = new THREE.Mesh(cube, material('#ffffff'));
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.userData.placeId = id;
    mesh.updateMatrixWorld(true);
    pickables.push(mesh);
  };

  scene.add(new THREE.HemisphereLight('#fff4db', '#7e956f', 2));
  const sun = new THREE.DirectionalLight('#ffe7bd', 2.7);
  sun.position.set(8, 35, 18);
  sun.target.position.set(24, 0, 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -35,
    right: 35,
    top: 30,
    bottom: -30,
    near: 0.5,
    far: 85,
  });
  sun.shadow.normalBias = 0.04;
  sun.shadow.bias = -0.0002;
  scene.add(sun, sun.target);

  box(24, -0.5, 16, 48, 0.8, 32, '#b7a482');
  box(24, -0.92, 16, 47.5, 0.12, 31.5, '#9d8a6b');
  const onPath = (x: number, z: number) =>
    (x >= 6 && x < 37 && z >= 14 && z < 17) ||
    (x >= 21 && x < 25 && z >= 14 && z < 30) ||
    (x >= 6 && x < 40 && z >= 21 && z < 24) ||
    (x >= 7 && x < 10 && z >= 16 && z < 24) ||
    (x >= 32 && x < 35 && z >= 13 && z < 23);
  for (let z = 0; z < HEIGHT; z++) {
    for (let x = 0; x < WIDTH; x++) {
      const seed = hash(x, z);
      const water = waterAt(x, z);
      const path = onPath(x, z) && !water;
      const color = water
        ? '#73b7bf'
        : path
          ? seed > 0.7
            ? '#e2c99b'
            : '#e8d2a7'
          : seed > 0.7
            ? '#94b96d'
            : seed < 0.25
              ? '#80a85e'
              : '#8bb367';
      box(x + 0.5, water ? -0.08 : -0.01, z + 0.5, 1, 0.12, 1, color);
      if (!water && !path && seed > 0.92) {
        box(x + 0.3, 0.12, z + 0.4, 0.07, 0.25, 0.07, '#709253');
        stamp(foliage, '#f4d997', x + 0.3, 0.28, z + 0.4, 0.12, 0.11, 0.12);
      }
    }
  }
  const waterMaterial = material('#73b7bf');
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 30; i++) {
    const x = 40 + hash(i, 3) * 7;
    const z = hash(i, 9) * HEIGHT;
    if (!waterAt(Math.floor(x), Math.floor(z)) || (z >= 21 && z < 24 && x < 45)) continue;
    const ripple = new THREE.Mesh(cube, material('#b6e0d8'));
    ripple.position.set(x, -0.005, z);
    ripple.scale.set(0.45 + hash(i, 5) * 0.5, 0.018, 0.045);
    scene.add(ripple);
    ripples.push(ripple);
  }

  // 桥、房屋和水景的位置与共享碰撞格对齐。
  for (let x = 37; x < 45; x++) box(x + 0.5, 0.14, 22.5, 0.94, 0.22, 3, '#b99161');
  for (const z of [21, 24]) {
    box(41, 0.78, z, 8.25, 0.16, 0.14, '#a17b51');
    for (let x = 37; x <= 45; x += 2) box(x, 0.52, z, 0.18, 1.1, 0.18, '#99734c');
  }
  for (let x = 1; x < 38; x += 2) {
    box(x, 0.65, 3, 0.18, 1.3, 0.18, '#b49b70');
    box(x + 0.9, 0.78, 3, 2, 0.18, 0.12, '#ccb58a');
  }
  const tree = (x: number, z: number, size = 1, autumn = false) => {
    stamp(cylinder, '#8c6e4b', x, 1 * size, z, 0.23 * size, 2 * size, 0.23 * size);
    const colors = autumn ? ['#b6a660', '#d1ba72', '#c4ae65'] : ['#6f9958', '#82a862', '#91b571'];
    for (const [i, part] of [
      [-0.65, 2.8, 0.1, 1.35],
      [0.7, 3, -0.1, 1.25],
      [0, 3.95, 0, 1.35],
    ].entries()) {
      stamp(
        foliage,
        colors[i],
        x + part[0] * size,
        part[1] * size,
        z + part[2] * size,
        part[3] * size,
        part[3] * 0.9 * size,
        part[3] * size,
      );
    }
  };
  for (const [x, z, size] of [
    [2, 8, 1.1],
    [1, 15, 1],
    [3, 23, 1.1],
    [4, 30, 1.1],
    [14, 5, 0.9],
    [29, 5, 1],
    [37, 7, 1],
    [37, 18, 0.9],
    [35, 29, 1.1],
    [45, 13, 1],
    [46, 30, 1.1],
  ])
    tree(x, z, size);

  for (const p of POINTS) {
    const [x, z, w, d] = p.rect;
    const cx = x + w / 2;
    const cz = z + d / 2;
    if (['library', 'welcome', 'bank'].includes(p.kind)) {
      const h = p.kind === 'library' ? 3.8 : 3;
      box(cx, h / 2, cz, w - 0.3, h, d - 0.3, p.kind === 'welcome' ? '#e0ba89' : '#efdab0');
      box(cx, 0.2, cz, w + 0.1, 0.4, d + 0.1, '#b7a585');
      for (let yy = 0.8; yy < h; yy += 0.65)
        box(cx, yy, z + d - 0.12, w - 0.2, 0.045, 0.04, '#c9ad80');
      for (const xx of [x + 0.15, x + w - 0.15])
        box(xx, h / 2, z + d - 0.06, 0.16, h, 0.2, '#ac8659');
      stamp(
        roof,
        p.kind === 'library' ? '#708b83' : p.kind === 'welcome' ? '#bd8466' : '#8e9e71',
        cx,
        h,
        cz,
        w + 0.65,
        2.1,
        d + 0.8,
      );
      box(cx, h + 0.03, cz, w + 0.75, 0.17, d + 0.9, '#866e51');
      const seam = p.kind === 'library' ? '#627c73' : p.kind === 'welcome' ? '#aa7158' : '#7c8c60';
      box(cx, h + 2.13, cz, w + 0.7, 0.14, 0.16, seam);
      for (let row = 1; row < 7; row++) {
        const dz = (((d + 0.8) / 2) * row) / 7;
        const yy = h + 2.1 * (1 - row / 7) + 0.025;
        for (const side of [-1, 1]) box(cx, yy, cz + dz * side, w + 0.65, 0.04, 0.055, seam);
      }
      for (const xx of [x - 0.01, x + w + 0.01]) {
        box(xx, 1.85, cz, 0.12, 1.3, 1.3, '#ad8d64');
        box(xx + (xx < cx ? -0.07 : 0.07), 1.85, cz, 0.03, 1.1, 1.1, '#a9cfcc');
      }
      const front = z + d + 0.02;
      const door = p.x + 0.5;
      box(door, 1.05, front, 1.35, 2.1, 0.15, '#886442');
      box(door, 1.55, front + 0.09, 0.94, 0.65, 0.07, '#b9d3be');
      stamp(foliage, '#e8c373', door + 0.42, 0.94, front + 0.18, 0.08, 0.08, 0.06);
      box(door, 0.1, front + 0.45, 2.15, 0.2, 0.8, '#d2bd98');
      for (const xx of [cx - w * 0.28, cx + w * 0.28]) {
        if (Math.abs(xx - door) < 1.3) continue;
        box(xx, 1.85, front, 1.25, 1.35, 0.16, '#ad8d64');
        box(xx, 1.85, front + 0.1, 1.04, 1.14, 0.06, '#a9cfcc');
        box(xx, 1.85, front + 0.15, 0.07, 1.14, 0.05, '#f6e7bd');
        box(xx, 1.85, front + 0.15, 1.04, 0.07, 0.05, '#f6e7bd');
        box(xx, 1.1, front + 0.15, 1.5, 0.16, 0.45, '#a4865a');
      }
      for (const xx of [x + 0.5, x + w - 0.5]) {
        box(xx, 0.25, front + 0.25, 0.6, 0.5, 0.6, '#bc8f65');
        for (const dx of [-0.17, 0.17]) {
          box(xx + dx, 0.7, front + 0.25, 0.04, 0.5, 0.04, '#729151');
          stamp(foliage, '#d7a09d', xx + dx, 0.98, front + 0.25, 0.2, 0.16, 0.2);
        }
      }
      if (p.kind === 'library') {
        box(x + w - 1.8, h + 1.8, cz - 1, 0.85, 2, 0.85, '#b1b2a0');
        box(x + w - 1.8, h + 2.82, cz - 1, 1.1, 0.18, 1.1, '#8e978a');
        for (let i = 0; i < 4; i++)
          box(x + 0.9 + i * 0.26, 0.5, front + 0.22, 0.2, 0.65, 0.42, OUTFITS[i]);
      }
      placeLabel(p.name, cx, h + 2.9, cz + 1);
      collider(p.id, cx, (h + 2) / 2, cz, w + 0.7, h + 2, d + 0.8);
    } else if (p.kind === 'market') {
      for (let i = 0; i < 3; i++) {
        const xx = x + 1.8 + i * 3.45;
        box(xx, 0.8, cz, 2.8, 1.25, 1.7, '#b28b5e');
        for (const dx of [-1.22, 1.22]) box(xx + dx, 1.6, cz, 0.12, 2.7, 0.12, '#937149');
        for (let j = 0; j < 6; j++)
          box(
            xx - 1.25 + j * 0.5,
            2.85,
            cz,
            0.5,
            0.16,
            2.25,
            j % 2 ? '#f3dfb4' : i === 1 ? '#83a38a' : '#c38772',
          );
        box(xx, 1.48, cz, 3.1, 0.16, 2, '#d2ae7a');
        for (let j = 0; j < 5; j++) {
          if (i === 0) box(xx - 1 + j * 0.48, 1.7, cz, 0.32, 0.33, 0.65, OUTFITS[j]);
          else
            stamp(
              foliage,
              i === 1 ? '#9cad6a' : '#d9af62',
              xx - 1 + j * 0.48,
              1.73,
              cz,
              0.25,
              0.25,
              0.25,
            );
        }
      }
      placeLabel(p.name, cx, 3.7, cz, 4);
      collider(p.id, cx, 1.5, cz, w, 3, d);
    } else if (p.kind === 'board') {
      for (const xx of [x + 0.3, x + w - 0.3]) box(xx, 1.25, cz, 0.18, 2.5, 0.2, '#96714b');
      box(cx, 1.8, cz, 2.9, 1.65, 0.28, '#a58052');
      box(cx, 1.8, cz + 0.16, 2.55, 1.35, 0.04, '#c8a16b');
      for (const xx of [cx - 0.6, cx + 0.55]) {
        box(xx, 1.8, cz + 0.2, 0.75, 1, 0.025, '#fff0ca');
        for (let row = 0; row < 3; row++)
          box(xx, 2.05 - row * 0.2, cz + 0.22, 0.46, 0.035, 0.02, '#c2a984');
      }
      stamp(roof, '#8c795b', cx, 2.65, cz, 3.5, 0.8, 1.5);
      placeLabel(p.name, cx, 3.95, cz, 4.8);
      collider(p.id, cx, 1.6, cz, 3.5, 3.3, 1.5);
    } else if (p.kind === 'tree') {
      tree(cx, cz, 1.5, true);
      box(cx - 1.35, 0.65, cz + 1.1, 0.85, 1.3, 0.65, '#b39565');
      box(cx - 1.35, 1.34, cz + 1.1, 1, 0.12, 0.8, '#efe0b2');
      placeLabel(p.name, cx, 7.6, cz, 4);
      collider(p.id, cx, 3.1, cz, w, 6.2, d);
    }
  }

  box(23.5, 0.18, 18.5, 3, 0.36, 3, '#aeb3a0');
  box(23.5, 0.39, 18.5, 2.65, 0.07, 2.65, '#83bdbe');
  for (const x of [22.05, 24.95]) box(x, 0.4, 18.5, 0.2, 0.25, 3, '#d8c9a5');
  for (const z of [17.05, 19.95]) box(23.5, 0.4, z, 3, 0.25, 0.2, '#d8c9a5');
  stamp(cylinder, '#d7cba9', 23.5, 0.85, 18.5, 0.2, 1.4, 0.2);
  stamp(cylinder, '#e5d7b7', 23.5, 1.5, 18.5, 0.65, 0.16, 0.65);
  stamp(foliage, '#b4dfda', 23.5, 1.75, 18.5, 0.12, 0.3, 0.12);
  for (const [x, z] of [
    [17, 18],
    [27, 17],
    [27, 25],
  ]) {
    box(x + 0.8, 0.7, z + 0.4, 1.9, 0.18, 0.65, '#b69b70');
    for (const xx of [x, x + 1.6]) box(xx, 0.34, z + 0.4, 0.15, 0.65, 0.52, '#8e7653');
    box(x + 0.8, 1.2, z + 0.1, 1.9, 0.45, 0.1, '#c4a77b');
  }
  box(14, 0.07, 19, 2.8, 0.06, 1.8, '#bf9883');
  box(14, 0.12, 19, 0.9, 0.08, 0.6, '#fff0cb');
  box(14, 0.17, 19, 0.025, 0.02, 0.6, '#aa916a');
  for (let z = 0; z < 3; z++)
    for (let x = 0; x < 4; x++) {
      box(3 + x * 0.7, 0.04, 25 + z * 0.8, 0.58, 0.12, 0.65, '#987b55');
      stamp(foliage, '#789b56', 3 + x * 0.7, 0.28, 25 + z * 0.8, 0.23, 0.3, 0.23);
    }
  // 装饰猫是场景物件，不进入在线成员列表。
  box(18.3, 0.27, 16.3, 0.55, 0.45, 0.3, '#d2b896');
  box(18.6, 0.53, 16.3, 0.32, 0.32, 0.32, '#dfc8a6');
  for (const x of [18.49, 18.71]) stamp(foliage, '#a48664', x, 0.75, 16.3, 0.08, 0.13, 0.08);

  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = batch.material !== waterMaterial;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }
  batches.clear();

  const markerGeometry = ownGeometry(new THREE.RingGeometry(0.3, 0.38, 32));
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: '#f7df91',
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  materials.add(markerMaterial);
  const destination = new THREE.Mesh(markerGeometry, markerMaterial);
  destination.rotation.x = -Math.PI / 2;
  destination.visible = false;
  scene.add(destination);

  const personMesh = (
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ) => {
    const mesh = new THREE.Mesh(cube, material(color));
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const createAvatar = (player: WorldPlayer): Avatar => {
    const root = new THREE.Group();
    const body = personMesh(root, 0, 0.92, 0, 0.6, 0.58, 0.4, OUTFITS[player.skin] || OUTFITS[0]);
    personMesh(root, 0, 1.48, 0, 0.57, 0.56, 0.48, '#edc49b');
    personMesh(root, 0, 1.8, -0.035, 0.64, 0.18, 0.55, '#69523f');
    personMesh(root, 0, 1.55, -0.23, 0.6, 0.4, 0.12, '#69523f');
    for (const x of [-0.14, 0.14]) personMesh(root, x, 1.5, 0.25, 0.055, 0.075, 0.03, '#493c31');
    for (const x of [-0.39, 0.39]) personMesh(root, x, 0.9, 0, 0.16, 0.5, 0.24, '#edc49b');
    const leg = (x: number) => {
      const joint = new THREE.Group();
      joint.position.set(x, 0.68, 0);
      personMesh(joint, 0, -0.28, 0, 0.22, 0.55, 0.25, '#665747');
      personMesh(joint, 0, -0.53, 0.06, 0.24, 0.15, 0.36, '#574737');
      root.add(joint);
      return joint;
    };
    const leftLeg = leg(-0.17);
    const rightLeg = leg(0.17);
    const name = label(player.name, Math.max(1.7, Math.min(4.5, player.name.length * 0.34 + 0.6)));
    name.position.y = 2.35;
    const emote = label('挥手', 1.4);
    emote.position.set(0.7, 2.95, 0);
    emote.visible = false;
    const ring = new THREE.Mesh(markerGeometry, markerMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.scale.setScalar(1.35);
    root.add(name, emote, ring);
    root.position.set(player.x + 0.5, 0, player.y + 0.5);
    scene.add(root);
    return {
      root,
      body,
      leftLeg,
      rightLeg,
      label: name,
      emote,
      ring,
      name: player.name,
      expression: 'wave',
    };
  };
  const updateCamera = () => {
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  };
  updateCamera();

  canvas.dataset.renderer = 'three-webgl';
  canvas.dataset.sceneReady = 'false';
  return {
    resize(width, height) {
      viewportWidth = Math.max(1, width);
      viewportHeight = Math.max(1, height);
      const span = preview ? 40 : width < 600 ? 23 : 40;
      const aspect = viewportWidth / viewportHeight;
      camera.left = (-span * aspect) / 2;
      camera.right = (span * aspect) / 2;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(viewportWidth, viewportHeight, false);
    },
    render(players, selfId, time, reduced) {
      if (disposed || renderer.getContext().isContextLost()) return;
      const dt = Math.min(100, Math.max(0, time - previousTime));
      const factor = reduced ? 1 : previousTime ? 1 - Math.exp(-dt / 65) : 1;
      previousTime = time;
      const present = new Set(players.map((p) => p.id));
      for (const [id, avatar] of avatars)
        if (!present.has(id)) {
          scene.remove(avatar.root);
          releaseLabel(avatar.label);
          releaseLabel(avatar.emote);
          avatars.delete(id);
        }
      for (const [index, player] of players.entries()) {
        let avatar = avatars.get(player.id);
        if (!avatar) {
          avatar = createAvatar(player);
          avatars.set(player.id, avatar);
        }
        const moving = player.moving && !reduced;
        const phase = time / 95 + index;
        avatar.root.position.x += (player.x + 0.5 - avatar.root.position.x) * factor;
        avatar.root.position.z += (player.y + 0.5 - avatar.root.position.z) * factor;
        avatar.root.position.y =
          (waterAt(player.x, player.y) ? 0.18 : 0) +
          (moving ? Math.abs(Math.sin(phase)) * 0.055 : 0);
        avatar.body.material = material(OUTFITS[player.skin] || OUTFITS[0]);
        avatar.body.rotation.set(0, 0, 0);
        const angle = facingAngles[player.facing] || 0;
        let difference = angle - avatar.root.rotation.y;
        difference = Math.atan2(Math.sin(difference), Math.cos(difference));
        avatar.root.rotation.y += difference * factor;
        avatar.leftLeg.rotation.x = moving ? Math.sin(phase) * 0.5 : 0;
        avatar.rightLeg.rotation.x = moving ? -Math.sin(phase) * 0.5 : 0;
        avatar.ring.visible = player.id === selfId;
        if (avatar.name !== player.name) {
          releaseLabel(avatar.label);
          avatar.root.remove(avatar.label);
          avatar.label = label(
            player.name,
            Math.max(1.7, Math.min(4.5, player.name.length * 0.34 + 0.6)),
          );
          avatar.label.position.y = 2.35;
          avatar.root.add(avatar.label);
          avatar.name = player.name;
        }
        if (player.emote && avatar.expression !== player.emote) {
          releaseLabel(avatar.emote);
          avatar.root.remove(avatar.emote);
          avatar.emote = label(
            player.emote === 'heart' ? '善意 ♡' : player.emote === 'idea' ? '有想法 !' : '挥手',
            1.7,
          );
          avatar.emote.position.set(0.7, 2.95, 0);
          avatar.root.add(avatar.emote);
          avatar.expression = player.emote;
        }
        avatar.emote.visible = Boolean(player.emote && player.emoteUntil > Date.now());
      }
      const self = avatars.get(selfId);
      if (self && !preview) {
        const cameraFactor = reduced ? 1 : 1 - Math.exp(-dt / 130);
        const cx =
          viewportWidth < 600
            ? self.root.position.x
            : THREE.MathUtils.clamp(self.root.position.x, 20, 28);
        target.x += (cx - target.x) * cameraFactor;
        target.z += (self.root.position.z - 1.5 - target.z) * cameraFactor;
      }
      updateCamera();
      if (!reduced) {
        for (const [i, ripple] of ripples.entries())
          ripple.position.x += Math.sin(time / 1700 + i) * dt * 0.000015;
        destination.scale.setScalar(1 + Math.sin(time / 260) * 0.12);
      }
      renderer.render(scene, camera);
      frames++;
      if (frames === 1 || frames % 30 === 0) {
        canvas.dataset.sceneReady = 'true';
        canvas.dataset.renderedFrames = String(frames);
        canvas.dataset.triangles = String(renderer.info.render.triangles);
      }
    },
    pick(clientX, clientY) {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height || disposed) return null;
      pointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      if (hit) {
        const place = POINTS.find((p) => p.id === hit.object.userData.placeId);
        if (place) return { position: { x: place.x, y: place.y }, placeId: place.id };
      }
      if (!raycaster.ray.intersectPlane(ground, intersection)) return null;
      const position = { x: Math.floor(intersection.x), y: Math.floor(intersection.z) };
      if (position.x < 0 || position.x >= WIDTH || position.y < 0 || position.y >= HEIGHT)
        return null;
      return { position };
    },
    setDestination(position) {
      destination.visible = Boolean(position);
      if (position) destination.position.set(position.x + 0.5, 0.19, position.y + 0.5);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const object of scene.children)
        if (object instanceof THREE.InstancedMesh) object.dispose();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((mat) => mat.dispose());
      textures.forEach((texture) => texture.dispose());
      sun.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      scene.clear();
      avatars.clear();
      pickables.length = 0;
    },
  };
}
