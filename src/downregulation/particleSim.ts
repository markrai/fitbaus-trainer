/**
 * CPU-side particle simulation for Downregulation: motion (noise + wave)
 * plus spatial-hash collision so particles don't overlap and bounce off each other.
 */

export const SIM_PARTICLE_COUNT = 2500;

// 3D gradient noise for motion for motion (smooth, fast). Returns 0..1, we scale to ~ -1..1.
const PERM: number[] = (() => {
  const p: number[] = [];
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p.concat(p);
})();
function grad3(h: number, x: number, y: number, z: number): number {
  const g = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
  ];
  const gv = g[h % 12];
  return gv[0] * x + gv[1] * y + gv[2] * z;
}
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function valueNoise3(px: number, py: number, pz: number): number {
  const X = Math.floor(px) & 255;
  const Y = Math.floor(py) & 255;
  const Z = Math.floor(pz) & 255;
  px -= Math.floor(px);
  py -= Math.floor(py);
  pz -= Math.floor(pz);
  const u = fade(px);
  const v = fade(py);
  const w = fade(pz);
  const A = PERM[X] + Y;
  const B = PERM[X + 1] + Y;
  const AA = (A + Z) & 255;
  const AB = (A + Z + 1) & 255;
  const BA = (B + Z) & 255;
  const BB = (B + Z + 1) & 255;
  const n000 = grad3(PERM[AA], px, py, pz);
  const n100 = grad3(PERM[BA], px - 1, py, pz);
  const n010 = grad3(PERM[AB], px, py - 1, pz);
  const n110 = grad3(PERM[BB], px - 1, py - 1, pz);
  const n001 = grad3(PERM[AB], px, py, pz - 1);
  const n101 = grad3(PERM[BB], px - 1, py, pz - 1);
  const n011 = grad3(PERM[(A + Z + 2) & 255], px, py - 1, pz - 1);
  const n111 = grad3(PERM[(B + Z + 2) & 255], px - 1, py - 1, pz - 1);
  const nx00 = n000 + u * (n100 - n000);
  const nx10 = n010 + u * (n110 - n010);
  const nx01 = n001 + u * (n101 - n001);
  const nx11 = n011 + u * (n111 - n011);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);
  return nxy0 + w * (nxy1 - nxy0);
}

const CELL_SIZE = 0.06;
const GRID_OFFSET = 1.2;
const GRID_CELLS = Math.ceil((2 * GRID_OFFSET) / CELL_SIZE) + 2;
const MIN_DIST = 0.028;
const NUM_COLLISION_ITER = 2;
/** Cap speed so collision resolution never propels particles past normal motion scale */
const MAX_SPEED = 0.10;

let positions: Float32Array;
let velocities: Float32Array;
let initialPositions: Float32Array;
let seeds: Float32Array;

function hashCell(cx: number, cy: number): number {
  return (cy + 100) * 200 + (cx + 100);
}

function getCell(x: number, y: number): number {
  const cx = Math.floor((x + GRID_OFFSET) / CELL_SIZE);
  const cy = Math.floor((y + GRID_OFFSET) / CELL_SIZE);
  return hashCell(cx, cy);
}

export function initParticleSim(): void {
  const n = SIM_PARTICLE_COUNT;
  positions = new Float32Array(n * 2);
  velocities = new Float32Array(n * 2);
  initialPositions = new Float32Array(n * 2);
  seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const i2 = i * 2;
    const x = (Math.random() * 2 - 1) * 1.2;
    const y = (Math.random() * 2 - 1) * 1.2;
    initialPositions[i2] = x;
    initialPositions[i2 + 1] = y;
    positions[i2] = x;
    positions[i2 + 1] = y;
    velocities[i2] = 0;
    velocities[i2 + 1] = 0;
    seeds[i] = i / n;
  }
}

export function getPositions(): Float32Array {
  return positions;
}

export function getSeeds(): Float32Array {
  return seeds;
}

export function getParticleCount(): number {
  return SIM_PARTICLE_COUNT;
}

function buildGrid(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let i = 0; i < SIM_PARTICLE_COUNT; i++) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    const cell = getCell(x, y);
    let list = map.get(cell);
    if (!list) {
      list = [];
      map.set(cell, list);
    }
    list.push(i);
  }
  return map;
}

function resolveCollisions(): void {
  for (let iter = 0; iter < NUM_COLLISION_ITER; iter++) {
    const gridMap = buildGrid();
    const n = SIM_PARTICLE_COUNT;
    for (let i = 0; i < n; i++) {
      const i2 = i * 2;
      const xi = positions[i2];
      const yi = positions[i2 + 1];
      const cx = Math.floor((xi + GRID_OFFSET) / CELL_SIZE);
      const cy = Math.floor((yi + GRID_OFFSET) / CELL_SIZE);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = gridMap.get(hashCell(cx + dx, cy + dy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const j2 = j * 2;
            const xj = positions[j2];
            const yj = positions[j2 + 1];
            const dx_ = xi - xj;
            const dy_ = yi - yj;
            const distSq = dx_ * dx_ + dy_ * dy_ * 1;
            if (distSq < MIN_DIST * MIN_DIST && distSq > 1e-10) {
              const dist = Math.sqrt(distSq);
              const nx = dx_ / dist;
              const ny = dy_ / dist;
              const overlap = MIN_DIST - dist;
              positions[i2] += nx * (overlap * 0.5);
              positions[i2 + 1] += ny * (overlap * 0.5);
              positions[j2] -= nx * (overlap * 0.5);
              positions[j2 + 1] -= ny * (overlap * 0.5);
              const vix = velocities[i2];
              const viy = velocities[i2 + 1];
              const vjx = velocities[j2];
              const vjy = velocities[j2 + 1];
              const viN = vix * nx + viy * ny;
              const vjN = vjx * nx + vjy * ny;
              // Equalize normal velocity (average): conserves momentum, no inadvertent kick
              const avgN = (viN + vjN) * 0.5;
              velocities[i2] = vix + (avgN - viN) * nx;
              velocities[i2 + 1] = viy + (avgN - viN) * ny;
              velocities[j2] = vjx + (avgN - vjN) * nx;
              velocities[j2 + 1] = vjy + (avgN - vjN) * ny;
            }
          }
        }
      }
    }
    // Cap speed so no particle gets propelled past normal scale
    for (let i = 0; i < n; i++) {
      const i2 = i * 2;
      const vx = velocities[i2];
      const vy = velocities[i2 + 1];
      const s = Math.sqrt(vx * vx + vy * vy);
      if (s > MAX_SPEED && s > 1e-6) {
        const f = MAX_SPEED / s;
        velocities[i2] = vx * f;
        velocities[i2 + 1] = vy * f;
      }
    }
  }
}

export function stepParticleSim(
  time: number,
  coherence: number,
  noiseAmplitude: number,
  speed: number,
  deltaTime: number,
  /** 0 = no motion (low/no HR), 1 = full motion (high HR). Particles only move when this is > 0. */
  movementScale: number
): void {
  const t = time * 0.1;
  const n = SIM_PARTICLE_COUNT;
  const step = 0.08 * speed * Math.min(deltaTime * 60, 2);
  const scale = Math.max(0, Math.min(1, movementScale));
  for (let i = 0; i < n; i++) {
    const i2 = i * 2;
    const x = positions[i2];
    const y = positions[i2 + 1];
    const seed = seeds[i];
    const sox = seed * 1000;
    const soy = seed * 2000;
    const st = seed * 500;
    const n1 = valueNoise3(x * 2 + sox, y * 2 + soy, t + st);
    const n2 = valueNoise3(x * 2 + sox + 100, y * 2 + soy + 200, t + st + 33.3);
    const noiseFlowX = n1 * noiseAmplitude * (1 - coherence);
    const noiseFlowY = n2 * noiseAmplitude * (1 - coherence);
    const wavePhase = t + seed * 6.28;
    const waveX = Math.sin(wavePhase) * 0.15 * coherence;
    const waveY = Math.cos(wavePhase * 0.7) * 0.15 * coherence;
    const vx = (noiseFlowX + waveX) * scale;
    const vy = (noiseFlowY + waveY) * scale;
    velocities[i2] = vx;
    velocities[i2 + 1] = vy;
    positions[i2] = x + vx * step;
    positions[i2 + 1] = y + vy * step;
  }
  resolveCollisions();
  for (let i = 0; i < n; i++) {
    const i2 = i * 2;
    let x = positions[i2];
    let y = positions[i2 + 1];
    x = Math.max(-1.25, Math.min(1.25, x));
    y = Math.max(-1.25, Math.min(1.25, y));
    positions[i2] = x;
    positions[i2 + 1] = y;
  }
}
