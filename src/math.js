// Pure lighting math. No DOM access here, so everything is unit-testable in Node.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const round = (v, p = 10) => Math.round(v * p) / p;
const RAD = Math.PI / 180;

/** Colour temperature (Kelvin) -> [r, g, b] in 0..255 (Tanner Helland approximation). */
export function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.round(clamp(v, 0, 255)));
}

/** Accepts a Kelvin number, an [r,g,b] array or a #hex string. */
export function parseColor(c) {
  if (typeof c === 'number') return kelvinToRgb(c);
  if (Array.isArray(c)) return c.slice(0, 3);
  if (typeof c === 'string' && c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new TypeError(`heliograph: unsupported colour ${c}`);
}

/**
 * Low-precision solar position (good to ~0.5°, plenty for shadows).
 * Returns altitude above the horizon and azimuth clockwise from north, in degrees.
 */
export function sunPosition(date, lat, lon) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { altitude: alt / RAD, azimuth: (az / RAD + 360) % 360 };
}

/**
 * Map a compass azimuth onto the screen. The screen is treated as a table seen
 * from above, rotated so the noon sun sits at the top (the UI convention).
 * Returns a unit vector pointing from the page *towards* the sun, y-down.
 */
export function azimuthToScreen(azimuth, lat) {
  const a = azimuth * RAD;
  return lat >= 0 ? { x: -Math.sin(a), y: Math.cos(a) } : { x: Math.sin(a), y: -Math.cos(a) };
}

// Atmosphere keyed by solar altitude: sky gradient, shadow tint, light temperature, intensity.
const SKY = [
  { alt: -18, top: [5, 7, 18], bottom: [14, 18, 40], shadow: [0, 2, 12], k: 9500, i: 0.28 },
  { alt: -6, top: [16, 22, 58], bottom: [74, 58, 118], shadow: [8, 8, 36], k: 8200, i: 0.38 },
  { alt: 0, top: [44, 62, 128], bottom: [255, 136, 92], shadow: [64, 18, 74], k: 2100, i: 0.78 },
  { alt: 6, top: [82, 122, 200], bottom: [255, 188, 128], shadow: [56, 32, 84], k: 3300, i: 0.95 },
  { alt: 20, top: [66, 136, 228], bottom: [168, 208, 250], shadow: [24, 32, 66], k: 5200, i: 1 },
  { alt: 60, top: [46, 126, 240], bottom: [188, 224, 255], shadow: [20, 27, 54], k: 6100, i: 1 },
];

export function skyAt(altitude) {
  if (altitude <= SKY[0].alt) return withLight(SKY[0]);
  for (let j = 1; j < SKY.length; j++) {
    const a = SKY[j - 1], b = SKY[j];
    if (altitude <= b.alt) {
      const t = (altitude - a.alt) / (b.alt - a.alt);
      return withLight({
        top: mix3(a.top, b.top, t),
        bottom: mix3(a.bottom, b.bottom, t),
        shadow: mix3(a.shadow, b.shadow, t),
        k: lerp(a.k, b.k, t),
        i: lerp(a.i, b.i, t),
      });
    }
  }
  return withLight(SKY[SKY.length - 1]);
}
const withLight = (s) => ({
  top: s.top.map(Math.round),
  bottom: s.bottom.map(Math.round),
  shadow: s.shadow.map(Math.round),
  color: kelvinToRgb(s.k),
  intensity: s.i,
});

/**
 * How one element sees the light.
 * `light` is either { kind:'point', x, y, h, intensity } (px, viewport space)
 * or { kind:'dir', dx, dy, altitude, intensity } (unit vector towards light).
 * Returns shadow offset per px of elevation (kx, ky), specular hotspot in
 * element-local % (lx, ly), specular strength, rim angle (CSS deg) and facing.
 */
export function illuminate(rect, z, light) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let kx, ky, lx, ly, spec, angle, facing;
  if (light.kind === 'point') {
    const vx = cx - light.x, vy = cy - light.y;
    const dist = Math.hypot(vx, vy);
    // Similar triangles: a point at height z, lit from height h, lands z/(h-z) further out.
    const denom = Math.max(light.h - z, light.h * 0.25);
    kx = vx / denom;
    ky = vy / denom;
    lx = ((light.x - rect.left) / Math.max(rect.width, 1)) * 100;
    ly = ((light.y - rect.top) / Math.max(rect.height, 1)) * 100;
    const falloff = 1 / (1 + (dist / (light.h * 1.4)) ** 2);
    spec = light.intensity * falloff;
    facing = light.intensity * clamp(1.15 - dist / (light.h * 2), 0.2, 1);
    angle = Math.atan2(-vx, vy) / RAD;
  } else {
    const cot = 1 / Math.tan(Math.max(light.altitude, 7) * RAD);
    kx = -light.dx * cot;
    ky = -light.dy * cot;
    lx = 50 + light.dx * 70;
    ly = 50 + light.dy * 70;
    spec = light.intensity * (0.45 + 0.55 * (1 - clamp(light.altitude, 0, 90) / 90));
    facing = light.intensity;
    angle = Math.atan2(light.dx, -light.dy) / RAD;
  }
  const k = Math.hypot(kx, ky);
  if (k > 3.2) { kx *= 3.2 / k; ky *= 3.2 / k; }
  return {
    kx, ky,
    lx: clamp(lx, -60, 160),
    ly: clamp(ly, -60, 160),
    spec: clamp(spec, 0, 1),
    angle: (angle + 360) % 360,
    facing: clamp(facing, 0, 1),
  };
}

// Offset multiplier, blur multiplier, alpha multiplier. Contact shadow -> far penumbra.
const LAYERS = [
  [0.12, 0.18, 0.62],
  [0.45, 0.8, 0.45],
  [1, 1.7, 0.3],
  [1.9, 3.4, 0.17],
];

/** Layered box-shadow for an element floating `z` px above the page. */
export function boxShadow(kx, ky, z, { rgb = [0, 0, 0], strength = 1, softness = 1, intensity = 1 } = {}) {
  if (z <= 0.05) return `0 0 0 0 rgb(${rgb.join(' ')} / 0)`;
  const c = rgb.map(Math.round).join(' ');
  const a0 = clamp(strength * (0.35 + 0.65 * intensity), 0, 2);
  const out = LAYERS.map(([o, b, a]) => {
    const ox = round(kx * z * o), oy = round(ky * z * o);
    const blur = round(z * b * softness + 1);
    const spread = round(-z * 0.08 * o);
    return `${ox}px ${oy}px ${blur}px ${spread}px rgb(${c} / ${round(a * a0, 1000)})`;
  });
  // Ambient occlusion from the sky dome: no direction, just proximity.
  out.push(`0 ${round(z * 0.1)}px ${round(z * 1.2 * softness + 2)}px 0 rgb(${c} / ${round(0.1 * strength, 1000)})`);
  return out.join(', ');
}

/** Two-layer text-shadow: a crisp contact line and a soft cast. */
export function textShadow(kx, ky, z, { rgb = [0, 0, 0], strength = 1, intensity = 1 } = {}) {
  const c = rgb.map(Math.round).join(' ');
  const a = clamp(strength * (0.3 + 0.7 * intensity), 0, 2);
  return [
    `${round(kx * z * 0.3)}px ${round(ky * z * 0.3)}px ${round(z * 0.3)}px rgb(${c} / ${round(0.35 * a, 1000)})`,
    `${round(kx * z)}px ${round(ky * z)}px ${round(z * 1.4 + 2)}px rgb(${c} / ${round(0.22 * a, 1000)})`,
  ].join(', ');
}

/** Frame-rate independent exponential smoothing factor. */
export const damp = (speed, dt) => 1 - Math.exp(-speed * dt);
