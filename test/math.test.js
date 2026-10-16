import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kelvinToRgb, parseColor, sunPosition, azimuthToScreen, skyAt, illuminate, boxShadow, textShadow,
} from '../src/math.js';

test('kelvinToRgb: warm is red-heavy, daylight is near white, cold is blue-heavy', () => {
  const [r1, , b1] = kelvinToRgb(2000);
  assert.equal(r1, 255);
  assert.ok(b1 < 60);
  const d = kelvinToRgb(6600);
  assert.ok(d.every((c) => c > 240));
  const [r3, , b3] = kelvinToRgb(12000);
  assert.ok(b3 === 255 && r3 < 220);
});

test('parseColor handles kelvin, arrays and hex', () => {
  assert.deepEqual(parseColor('#ff8000'), [255, 128, 0]);
  assert.deepEqual(parseColor('#f80'), [255, 136, 0]);
  assert.deepEqual(parseColor([1, 2, 3, 4]), [1, 2, 3]);
  assert.equal(parseColor(5000).length, 3);
  assert.throws(() => parseColor('red'));
});

test('sunPosition: Seoul summer solstice', () => {
  // Solar noon in Seoul is ~12:30 KST = 03:30 UTC. Max altitude ≈ 90 - 37.57 + 23.44 ≈ 75.9°
  const noon = sunPosition(new Date('2026-06-21T03:30:00Z'), 37.57, 126.98);
  assert.ok(Math.abs(noon.altitude - 75.9) < 1.5, `altitude ${noon.altitude}`);
  assert.ok(Math.abs(noon.azimuth - 180) < 12, `azimuth ${noon.azimuth}`);
  const midnight = sunPosition(new Date('2026-06-21T15:30:00Z'), 37.57, 126.98);
  assert.ok(midnight.altitude < -20);
  const morning = sunPosition(new Date('2026-06-20T22:00:00Z'), 37.57, 126.98); // 07:00 KST
  assert.ok(morning.azimuth > 50 && morning.azimuth < 100, `morning azimuth ${morning.azimuth}`);
  assert.ok(morning.altitude > 10 && morning.altitude < 35);
});

test('azimuthToScreen puts the noon sun at the top in both hemispheres', () => {
  const n = azimuthToScreen(180, 37);
  assert.ok(Math.abs(n.x) < 1e-9 && Math.abs(n.y + 1) < 1e-9);
  const s = azimuthToScreen(0, -33);
  assert.ok(Math.abs(s.x) < 1e-9 && Math.abs(s.y + 1) < 1e-9);
  // Northern morning (east): light from the left, so shadows go right.
  assert.ok(azimuthToScreen(90, 37).x < -0.99);
});

test('skyAt interpolates and goes warm at the horizon', () => {
  const dusk = skyAt(1);
  const noon = skyAt(70);
  assert.ok(dusk.color[2] < noon.color[2], 'sunset light is warmer');
  assert.ok(skyAt(-30).intensity < 0.3);
  const mid = skyAt(13);
  assert.ok(mid.intensity > 0.95 && mid.intensity <= 1);
});

test('illuminate: point light casts shadows away from itself', () => {
  const rect = { left: 400, top: 400, width: 200, height: 100 };
  const light = { kind: 'point', x: 0, y: 0, h: 800, intensity: 1 };
  const r = illuminate(rect, 10, light);
  assert.ok(r.kx > 0 && r.ky > 0, 'shadow pushes down-right');
  assert.ok(r.lx < 0 && r.ly < 0, 'hotspot sits up-left');
  // Light directly above: no offset, hotspot centered.
  const above = illuminate(rect, 10, { ...light, x: 500, y: 450 });
  assert.ok(Math.abs(above.kx) < 1e-9 && Math.abs(above.ky) < 1e-9);
  assert.equal(above.lx, 50);
});

test('illuminate: low sun throws longer shadows than high sun, capped', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  const base = { kind: 'dir', dx: 0, dy: -1, intensity: 1 };
  const low = illuminate(rect, 10, { ...base, altitude: 10 });
  const high = illuminate(rect, 10, { ...base, altitude: 70 });
  assert.ok(low.ky > high.ky && high.ky > 0, 'light from top pushes shadows down');
  const flat = illuminate(rect, 10, { ...base, altitude: 0.1 });
  assert.ok(Math.hypot(flat.kx, flat.ky) <= 3.2 + 1e-9);
});

test('boxShadow / textShadow produce valid layered strings', () => {
  const s = boxShadow(0.5, 1, 12, { rgb: [10, 20, 30] });
  assert.equal(s.split('), ').length, 5);
  assert.match(s, /^[-\d.]+px [-\d.]+px [\d.]+px [-\d.]+px rgb\(10 20 30 \/ [\d.]+\)/);
  assert.match(boxShadow(1, 1, 0), /\/ 0\)$/);
  assert.equal(textShadow(1, 1, 3).split('), ').length, 2);
});
