/**
 * WebGL2 particle-field renderer for Downregulation.
 * - Center circle: blue-green (hue 180–200°, low-med sat, mid-low luminance). Soft halo that
 *   breathes slowly; lower HR = slower expansion/contraction cycle and slightly tighter halo.
 *   No snapping, no brightness spikes (nervous system mirror).
 * - Starfield: particles as gl.POINTS; coherence reduces noise, adds wave (no center pull).
 * - Baseline = first 30s (hrController). Dark background (#05060A).
 */
import { getCurrentBpm } from "../hrMonitor.js";
import { getCoherenceFactor, getSmoothedHR } from "./hrController.js";
import { getParticleCount, getPositions, getSeeds, initParticleSim, stepParticleSim, } from "./particleSim.js";
// Particle count comes from sim (CPU collision); vertex shader only uses position
const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in float a_seed;
uniform float u_coherence;
uniform float u_particleSizeScale;
out float v_alpha;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  float baseSize = (5.0 + 3.0 * u_coherence) * u_particleSizeScale;
  gl_PointSize = baseSize;
  v_alpha = 0.6 + 0.4 * u_coherence;
}
`;
const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in float v_alpha;
uniform sampler2D u_pointTexture;
out vec4 outColor;
void main() {
  vec4 tex = texture(u_pointTexture, gl_PointCoord);
  float a = tex.a * v_alpha;
  vec3 col = mix(vec3(0.35, 0.65, 0.75), vec3(0.4, 0.45, 0.7), 0.5);
  col = mix(col, vec3(0.5, 0.4, 0.65), 0.3);
  outColor = vec4(col, a);
}
`;
// Starfield mode: GPU-driven motion (noise + wave + gravity in vertex shader), 12k points, no collision
const STARFIELD_PARTICLE_COUNT = 12000;
const STARFIELD_VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in float a_seed;
uniform float u_time;
uniform float u_coherence;
uniform float u_noiseAmplitude;
uniform float u_gravityStrength;
uniform float u_speed;
out float v_alpha;
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
void main() {
  vec2 uv = a_position;
  float t = u_time * 0.1;
  float seed = a_seed;
  float seedOffsetX = seed * 1000.0;
  float seedOffsetY = seed * 2000.0;
  float seedTimeOffset = seed * 500.0;
  float n1 = snoise(vec3(uv.x * 2.0 + seedOffsetX, uv.y * 2.0 + seedOffsetY, t + seedTimeOffset));
  float n2 = snoise(vec3(uv.x * 2.0 + seedOffsetX + 100.0, uv.y * 2.0 + seedOffsetY + 200.0, t + seedTimeOffset + 33.3));
  vec2 noiseFlow = vec2(n1, n2) * u_noiseAmplitude * (1.0 - u_coherence);
  float wavePhase = t + seed * 6.28;
  vec2 wave = vec2(sin(wavePhase), cos(wavePhase * 0.7)) * 0.15 * u_coherence;
  vec2 toCenter = -uv;
  float dist = length(toCenter) + 0.001;
  vec2 gravity = normalize(toCenter) * u_gravityStrength * u_coherence * 0.02 / (dist + 0.5);
  vec2 velocity = noiseFlow + wave + gravity;
  vec2 pos = uv + velocity * 0.08 * u_speed;
  gl_Position = vec4(pos.x, pos.y, 0.0, 1.0);
  float baseSize = (5.0 + 3.0 * u_coherence);
  gl_PointSize = baseSize;
  v_alpha = 0.6 + 0.4 * u_coherence;
}
`;
const STARFIELD_FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in float v_alpha;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float soft = 1.0 - smoothstep(0.0, 0.5, d);
  float a = soft * v_alpha;
  vec3 col = mix(vec3(0.35, 0.65, 0.75), vec3(0.4, 0.45, 0.7), 0.5);
  col = mix(col, vec3(0.5, 0.4, 0.65), 0.3);
  outColor = vec4(col, a);
}
`;
// Goo mode: lava lamp is drawn by SVG overlay in overlay.ts (feGaussianBlur + feColorMatrix, lamp clip path).
// Center circle: blue-green soft halo; lower HR = slower breath, slightly tighter (no snap, no brightness spikes)
const CIRCLE_VERTEX = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
const CIRCLE_FRAGMENT = `#version 300 es
precision mediump float;
uniform float u_time;
uniform float u_coherence;
uniform vec2 u_resolution;
out vec4 outColor;
const vec3 circleColor = vec3(0.14, 0.32, 0.34);
void main() {
  vec2 ndc = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = vec2(ndc.x * aspect, ndc.y);
  float dist = length(uv);
  float breathSpeed = 0.10 * (1.0 - 0.70 * u_coherence);
  float phase = u_time * breathSpeed;
  float breath = sin(phase) * 0.04;
  float innerR = 0.10;
  float baseOuter = 0.42 - 0.06 * u_coherence;
  float outerR = baseOuter + breath;
  float alpha = 1.0 - smoothstep(innerR, outerR, dist);
  alpha *= 0.55;
  outColor = vec4(circleColor, alpha);
}
`;
const BG_R = 5 / 255;
const BG_G = 6 / 255;
const BG_B = 10 / 255;
let gl = null;
let program = null;
let positionBuffer = null;
let seedBuffer = null;
let uCoherence = null;
let uParticleSizeScale = null;
let uPointTexture = null;
let uResolution = null;
let pointTexture = null;
const PARTICLE_SIZE_STORAGE_KEY = "downregulationParticleSizeScale";
const PARTICLE_SIZE_DEFAULT = 1.0;
const PARTICLE_STYLE_STORAGE_KEY = "downregulationParticleStyle";
const PARTICLE_STYLE_DEFAULT = "beads";
const NOISE_ENTROPY_MIN_BPM_KEY = "downregulationNoiseEntropyMinBpm";
const NOISE_ENTROPY_MIN_BPM_DEFAULT = 40;
const NOISE_ENTROPY_MAX_BPM = 150;
let particleSizeScale = PARTICLE_SIZE_DEFAULT;
let particleStyle = PARTICLE_STYLE_DEFAULT;
let noiseEntropyMinBpm = NOISE_ENTROPY_MIN_BPM_DEFAULT;
(function loadParticlePreferences() {
    try {
        const storedSize = localStorage.getItem(PARTICLE_SIZE_STORAGE_KEY);
        if (storedSize != null) {
            const v = parseFloat(storedSize);
            if (Number.isFinite(v) && v >= 1 && v <= 3)
                particleSizeScale = v;
        }
        const storedStyle = localStorage.getItem(PARTICLE_STYLE_STORAGE_KEY);
        if (storedStyle === "beads" || storedStyle === "starfield" || storedStyle === "goo" || storedStyle === "noise")
            particleStyle = storedStyle;
        const storedMinBpm = localStorage.getItem(NOISE_ENTROPY_MIN_BPM_KEY);
        if (storedMinBpm != null) {
            const v = parseInt(storedMinBpm, 10);
            if (Number.isFinite(v) && v >= 30 && v < NOISE_ENTROPY_MAX_BPM)
                noiseEntropyMinBpm = v;
        }
    }
    catch {
        /* ignore */
    }
})();
export function getParticleStyle() {
    return particleStyle;
}
export function setParticleStyle(value) {
    if (value !== "beads" && value !== "starfield" && value !== "goo" && value !== "noise")
        return;
    particleStyle = value;
    try {
        localStorage.setItem(PARTICLE_STYLE_STORAGE_KEY, value);
    }
    catch {
        /* ignore */
    }
}
export function getNoiseEntropyMinBpm() {
    return noiseEntropyMinBpm;
}
export function setNoiseEntropyMinBpm(value) {
    const v = Math.floor(Math.max(30, Math.min(NOISE_ENTROPY_MAX_BPM - 1, value)));
    noiseEntropyMinBpm = v;
    try {
        localStorage.setItem(NOISE_ENTROPY_MIN_BPM_KEY, String(v));
    }
    catch {
        /* ignore */
    }
}
let circleProgram = null;
let circleQuadBuffer = null;
let circleUTime = null;
let circleUCoherence = null;
let circleUResolution = null;
let starfieldProgram = null;
let starfieldPositionBuffer = null;
let starfieldSeedBuffer = null;
let starfieldUTime = null;
let starfieldUCoherence = null;
let starfieldUNoiseAmplitude = null;
let starfieldUGravityStrength = null;
let starfieldUSpeed = null;
function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader)
        return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}
function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vs || !fs)
        return null;
    const prog = gl.createProgram();
    if (!prog)
        return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("Program link:", gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
    }
    return prog;
}
function createCircleProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, CIRCLE_VERTEX);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, CIRCLE_FRAGMENT);
    if (!vs || !fs)
        return null;
    const prog = gl.createProgram();
    if (!prog)
        return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("Circle program link:", gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
    }
    return prog;
}
function createStarfieldProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, STARFIELD_VERTEX_SOURCE);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, STARFIELD_FRAGMENT_SOURCE);
    if (!vs || !fs)
        return null;
    const prog = gl.createProgram();
    if (!prog)
        return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("Starfield program link:", gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
    }
    return prog;
}
function createStarfieldBuffers(gl) {
    const positions = new Float32Array(STARFIELD_PARTICLE_COUNT * 2);
    const seeds = new Float32Array(STARFIELD_PARTICLE_COUNT);
    for (let i = 0; i < STARFIELD_PARTICLE_COUNT; i++) {
        const i2 = i * 2;
        const x = (Math.random() * 2 - 1) * 1.2;
        const y = (Math.random() * 2 - 1) * 1.2;
        positions[i2] = x;
        positions[i2 + 1] = y;
        seeds[i] = i / STARFIELD_PARTICLE_COUNT;
    }
    starfieldPositionBuffer = gl.createBuffer();
    if (!starfieldPositionBuffer)
        return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, starfieldPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    starfieldSeedBuffer = gl.createBuffer();
    if (!starfieldSeedBuffer)
        return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, starfieldSeedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return true;
}
function createCircleQuad(gl) {
    const buf = gl.createBuffer();
    if (!buf)
        return null;
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return buf;
}
const POINT_TEX_SIZE = 128;
function createPointTexture(gl) {
    const size = POINT_TEX_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx)
        return null;
    const center = size / 2;
    // Sharp circle: solid to ~90% radius, then thin antialiased edge (so scaled points stay crisp)
    const solidRadius = 0.88 * center;
    const edgeStart = 0.92 * center;
    const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(solidRadius / center, "rgba(255,255,255,1)");
    gradient.addColorStop(edgeStart / center, "rgba(255,255,255,0.85)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = gl.createTexture();
    if (!tex)
        return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
}
function createParticleBuffers(gl) {
    initParticleSim();
    const positions = getPositions();
    const seeds = getSeeds();
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    seedBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return true;
}
export function initRenderer(canvas) {
    console.log("[Renderer] Attempting to get WebGL2 context...");
    const ctx = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
    });
    if (!ctx) {
        console.error("[Renderer] WebGL2 not available");
        return false;
    }
    console.log("[Renderer] WebGL2 context acquired");
    gl = ctx;
    program = createProgram(gl);
    if (!program) {
        console.error("[Renderer] Failed to create program");
        return false;
    }
    console.log("[Renderer] Shader program created");
    if (!createParticleBuffers(gl)) {
        console.error("[Renderer] Failed to create particle buffers");
        return false;
    }
    console.log("[Renderer] Particle buffers created:", getParticleCount(), "particles");
    uCoherence = gl.getUniformLocation(program, "u_coherence");
    uParticleSizeScale = gl.getUniformLocation(program, "u_particleSizeScale");
    uPointTexture = gl.getUniformLocation(program, "u_pointTexture");
    uResolution = gl.getUniformLocation(program, "u_resolution");
    pointTexture = createPointTexture(gl);
    if (!pointTexture) {
        console.warn("[Renderer] Failed to create point texture, particles may look soft");
    }
    circleProgram = createCircleProgram(gl);
    circleQuadBuffer = createCircleQuad(gl);
    if (!circleProgram || !circleQuadBuffer) {
        console.error("[Renderer] Failed to create circle program/quad");
        return false;
    }
    circleUTime = gl.getUniformLocation(circleProgram, "u_time");
    circleUCoherence = gl.getUniformLocation(circleProgram, "u_coherence");
    circleUResolution = gl.getUniformLocation(circleProgram, "u_resolution");
    starfieldProgram = createStarfieldProgram(gl);
    if (!starfieldProgram || !createStarfieldBuffers(gl)) {
        console.warn("[Renderer] Starfield program/buffers failed, only Beads will be available");
        if (starfieldProgram)
            gl.deleteProgram(starfieldProgram);
        starfieldProgram = null;
    }
    else {
        starfieldUTime = gl.getUniformLocation(starfieldProgram, "u_time");
        starfieldUCoherence = gl.getUniformLocation(starfieldProgram, "u_coherence");
        starfieldUNoiseAmplitude = gl.getUniformLocation(starfieldProgram, "u_noiseAmplitude");
        starfieldUGravityStrength = gl.getUniformLocation(starfieldProgram, "u_gravityStrength");
        starfieldUSpeed = gl.getUniformLocation(starfieldProgram, "u_speed");
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    return true;
}
export function resize(canvas) {
    if (!gl)
        return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = window.innerWidth + "px";
        canvas.style.height = window.innerHeight + "px";
        gl.viewport(0, 0, w, h);
    }
}
let rafId = null;
const startTime = Date.now() / 1000;
let smoothedTimeSpeed = 1.0;
let smoothedMovementScale = 0.0;
let smoothedNoiseEntropyScale = 0.0;
let scaledTime = 0.0;
let lastFrameTime = Date.now() / 1000;
const SPEED_SMOOTH_ALPHA = 0.12; // Balance: smooth but visible response to HR within a few seconds
const NOISE_ENTROPY_SMOOTH_ALPHA = 0.04; // Slower than speed/movement so circle warp responds gently to HR
function tick() {
    var _a, _b;
    if (!gl || !program)
        return;
    const coherence = getCoherenceFactor();
    const now = Date.now() / 1000;
    const deltaTime = Math.min(0.1, now - lastFrameTime); // Clamp to avoid big jumps when tab backgrounded
    lastFrameTime = now;
    // Speed modulation based on HR: 40 bpm → 0.25 (min), 120 bpm → 1.0 (cap)
    const currentHR = (_b = (_a = getSmoothedHR()) !== null && _a !== void 0 ? _a : getCurrentBpm()) !== null && _b !== void 0 ? _b : null;
    let targetTimeSpeed = 0.5; // Default when no HR
    if (currentHR != null && currentHR > 0) {
        const rawSpeed = 0.25 + (0.75 * (currentHR - 40)) / 80; // 40→0.25, 120→1.0
        targetTimeSpeed = Math.max(0.25, Math.min(1, rawSpeed));
    }
    smoothedTimeSpeed = smoothedTimeSpeed + (targetTimeSpeed - smoothedTimeSpeed) * SPEED_SMOOTH_ALPHA;
    // Movement scale: particles have no motion of their own; only move when HR is present. 40 bpm → 0, 120 bpm → 1.
    let targetMovementScale = 0;
    if (currentHR != null && currentHR > 40) {
        targetMovementScale = Math.min(1, (currentHR - 40) / 80);
    }
    smoothedMovementScale = smoothedMovementScale + (targetMovementScale - smoothedMovementScale) * SPEED_SMOOTH_ALPHA;
    // Noise entropy: noiseEntropyMinBpm → 0, 150 bpm → 1. Used by noise overlay for warp/zoom.
    const minBpm = noiseEntropyMinBpm;
    const rangeBpm = NOISE_ENTROPY_MAX_BPM - minBpm;
    let targetNoiseEntropy = 0;
    if (currentHR != null && rangeBpm > 0 && currentHR >= minBpm) {
        targetNoiseEntropy = Math.min(1, (currentHR - minBpm) / rangeBpm);
    }
    smoothedNoiseEntropyScale = smoothedNoiseEntropyScale + (targetNoiseEntropy - smoothedNoiseEntropyScale) * NOISE_ENTROPY_SMOOTH_ALPHA;
    // Accumulate scaled time based on current speed (prevents "catch-up" jumps)
    scaledTime += smoothedTimeSpeed * deltaTime;
    const time = scaledTime;
    const noiseAmplitude = 0.4 * (1 - coherence) + 0.1;
    const gravityStrength = 0.5 + coherence * 1.5;
    const style = getParticleStyle();
    if (style === "beads") {
        stepParticleSim(time, coherence, noiseAmplitude, smoothedTimeSpeed, deltaTime, smoothedMovementScale);
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(BG_R, BG_G, BG_B, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (circleProgram && circleQuadBuffer) {
        gl.useProgram(circleProgram);
        gl.uniform1f(circleUTime, time);
        gl.uniform1f(circleUCoherence, coherence);
        gl.uniform2f(circleUResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        const circlePosLoc = gl.getAttribLocation(circleProgram, "a_position");
        gl.bindBuffer(gl.ARRAY_BUFFER, circleQuadBuffer);
        gl.enableVertexAttribArray(circlePosLoc);
        gl.vertexAttribPointer(circlePosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    }
    if (style === "starfield" && starfieldProgram && starfieldPositionBuffer && starfieldSeedBuffer) {
        const starfieldSpeed = smoothedTimeSpeed * smoothedMovementScale;
        gl.useProgram(starfieldProgram);
        if (starfieldUTime)
            gl.uniform1f(starfieldUTime, time);
        if (starfieldUCoherence)
            gl.uniform1f(starfieldUCoherence, coherence);
        if (starfieldUNoiseAmplitude)
            gl.uniform1f(starfieldUNoiseAmplitude, noiseAmplitude);
        if (starfieldUGravityStrength)
            gl.uniform1f(starfieldUGravityStrength, gravityStrength);
        if (starfieldUSpeed)
            gl.uniform1f(starfieldUSpeed, starfieldSpeed);
        const posLoc = gl.getAttribLocation(starfieldProgram, "a_position");
        const seedLoc = gl.getAttribLocation(starfieldProgram, "a_seed");
        gl.bindBuffer(gl.ARRAY_BUFFER, starfieldPositionBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, starfieldSeedBuffer);
        gl.enableVertexAttribArray(seedLoc);
        gl.vertexAttribPointer(seedLoc, 1, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, STARFIELD_PARTICLE_COUNT);
    }
    else if (style === "goo") {
        // Goo is drawn by SVG overlay (lava lamp with feGaussianBlur + feColorMatrix); canvas only does bg + circle
    }
    else if (style === "noise") {
        // Noise is drawn by canvas overlay (concentric warped circles with simplex noise)
    }
    else {
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, getPositions());
        gl.useProgram(program);
        gl.uniform1f(uCoherence, coherence);
        if (uParticleSizeScale)
            gl.uniform1f(uParticleSizeScale, particleSizeScale);
        if (uResolution)
            gl.uniform2f(uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
        if (pointTexture && uPointTexture != null) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, pointTexture);
            gl.uniform1i(uPointTexture, 0);
        }
        const posLoc = gl.getAttribLocation(program, "a_position");
        const seedLoc = gl.getAttribLocation(program, "a_seed");
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
        gl.enableVertexAttribArray(seedLoc);
        gl.vertexAttribPointer(seedLoc, 1, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, getParticleCount());
    }
    const err = gl.getError();
    if (err !== gl.NO_ERROR && Math.random() < 0.01) {
        console.warn("[Renderer] WebGL error after draw:", err);
    }
    rafId = requestAnimationFrame(tick);
}
export function startRenderLoop(canvas) {
    console.log("[Renderer] Starting render loop");
    resize(canvas);
    console.log("[Renderer] Canvas resized to", canvas.width, "x", canvas.height);
    scaledTime = 0.0;
    smoothedMovementScale = 0.0;
    lastFrameTime = Date.now() / 1000;
    if (rafId != null)
        cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
}
export function stopRenderLoop() {
    if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}
export function disposeRenderer() {
    stopRenderLoop();
    smoothedTimeSpeed = 1.0;
    smoothedMovementScale = 0.0;
    scaledTime = 0.0;
    lastFrameTime = Date.now() / 1000;
    if (gl && positionBuffer) {
        gl.deleteBuffer(positionBuffer);
        positionBuffer = null;
    }
    if (gl && seedBuffer) {
        gl.deleteBuffer(seedBuffer);
        seedBuffer = null;
    }
    if (gl && starfieldPositionBuffer) {
        gl.deleteBuffer(starfieldPositionBuffer);
        starfieldPositionBuffer = null;
    }
    if (gl && starfieldSeedBuffer) {
        gl.deleteBuffer(starfieldSeedBuffer);
        starfieldSeedBuffer = null;
    }
    if (gl && starfieldProgram) {
        gl.deleteProgram(starfieldProgram);
        starfieldProgram = null;
    }
    if (gl && circleQuadBuffer) {
        gl.deleteBuffer(circleQuadBuffer);
        circleQuadBuffer = null;
    }
    if (gl && circleProgram) {
        gl.deleteProgram(circleProgram);
        circleProgram = null;
    }
    if (gl && program) {
        gl.deleteProgram(program);
        program = null;
    }
    if (gl && pointTexture) {
        gl.deleteTexture(pointTexture);
        pointTexture = null;
    }
    gl = null;
}
export function getParticleSizeScale() {
    return particleSizeScale;
}
/** 0 = no/low HR (no motion), 1 = high HR. Used by goo overlay to scale animation. */
export function getMovementScale() {
    return smoothedMovementScale;
}
/** 0 = 40 bpm, 1 = 150 bpm. Used by noise overlay for entropy (warp/zoom). */
export function getNoiseEntropyScale() {
    return smoothedNoiseEntropyScale;
}
export function setParticleSizeScale(value) {
    const v = Math.max(1, Math.min(3, value));
    particleSizeScale = v;
    try {
        localStorage.setItem(PARTICLE_SIZE_STORAGE_KEY, String(v));
    }
    catch {
        /* ignore */
    }
}
