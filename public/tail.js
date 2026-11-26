// 彗星尾巴：衛星剛飛過的一段軌跡，畫成一條面向鏡頭的發光帶子。
// 頭（衛星位置）最寬最亮、中心偏白，往後變細、變暗到透明。用加法混色，重疊處會更亮。
// 寬度以螢幕像素計算（在頂點 shader 裡把每個點往螢幕上的法線方向推開），
// 所以不管拉多遠都一樣粗。軌跡的點由 app.js 用 SGP4 算好傳進來（[0] 是頭）。
import * as THREE from 'three';

export const TAIL_POINTS = 40;

// 所有尾巴共用：畫布實際像素大小（resize 時更新）
export const tailResolution = { value: new THREE.Vector2(1, 1) };

const vertexShader = /* glsl */ `
  attribute vec3 prevPos;  // 往頭的方向的鄰點
  attribute vec3 nextPos;  // 往尾的方向的鄰點
  attribute float side;    // -1 或 1
  attribute float t;       // 0 = 頭，1 = 尾
  uniform vec2 resolution;
  uniform float widthPx;
  varying float vT;
  varying float vSide;

  vec2 screen(vec4 c) { return c.xy / c.w * resolution * 0.5; }

  void main() {
    mat4 mvp = projectionMatrix * modelViewMatrix;
    vec4 c = mvp * vec4(position, 1.0);
    vec4 n = mvp * vec4(nextPos, 1.0);
    vec4 p = mvp * vec4(prevPos, 1.0);
    // 鄰點跑到鏡頭後面時（台灣仰望視角）改用另一邊的鄰點算方向
    vec2 dir = n.w > 0.0 ? screen(n) - screen(c) : screen(c) - screen(p);
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    float half_ = 0.5 * widthPx * mix(1.0, 0.25, t);
    c.xy += normal * side * half_ / (resolution * 0.5) * c.w;
    vT = t;
    vSide = side;
    gl_Position = c;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vT;
  varying float vSide;
  void main() {
    float d = abs(vSide);
    float core = exp(-d * d * 7.0);         // 中間亮亮的一條
    float glow = pow(1.0 - d, 1.5);         // 外圍的光暈
    float fade = pow(1.0 - vT, 1.3);        // 越往尾巴越淡
    vec3 col = mix(color, vec3(1.0), core * (1.0 - vT) * 0.6);
    float a = fade * (core * 1.1 + glow * 0.7) * opacity;
    gl_FragColor = vec4(col * a, 1.0);      // 加法混色：直接把顏色乘上強度
  }
`;

export function makeTail(color) {
  const n = TAIL_POINTS;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'prevPos', 'nextPos']) {
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
  }
  const side = new Float32Array(n * 2), t = new Float32Array(n * 2);
  const index = [];
  for (let i = 0; i < n; i++) {
    side[i * 2] = -1; side[i * 2 + 1] = 1;
    t[i * 2] = t[i * 2 + 1] = i / (n - 1);
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  g.setAttribute('side', new THREE.BufferAttribute(side, 1));
  g.setAttribute('t', new THREE.BufferAttribute(t, 1));
  g.setIndex(index);
  const m = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      color: { value: color }, opacity: { value: 1 }, widthPx: { value: 9 }, resolution: tailResolution,
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, // 帶子在螢幕上的繞向不固定，不能剔除背面
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 5;
  return mesh;
}

// pts：TAIL_POINTS 個 Vector3，[0] 是頭
export function setTailPoints(mesh, pts) {
  const a = mesh.geometry.attributes;
  const n = pts.length;
  const ext = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    // 兩端沒有鄰點：用外插的點，帶子才不會在端點翻面
    const prev = i > 0 ? pts[i - 1] : ext.copy(p).multiplyScalar(2).sub(pts[1]);
    for (const k of [0, 1]) {
      a.position.setXYZ(i * 2 + k, p.x, p.y, p.z);
      a.prevPos.setXYZ(i * 2 + k, prev.x, prev.y, prev.z);
    }
    const next = i < n - 1 ? pts[i + 1] : ext.copy(p).multiplyScalar(2).sub(pts[n - 2]);
    for (const k of [0, 1]) a.nextPos.setXYZ(i * 2 + k, next.x, next.y, next.z);
  }
  a.position.needsUpdate = a.prevPos.needsUpdate = a.nextPos.needsUpdate = true;
}

export function disposeTail(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}
