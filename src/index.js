import {
  clamp, lerp, mix3, damp, parseColor, sunPosition, azimuthToScreen,
  skyAt, illuminate, boxShadow, textShadow,
} from './math.js';

export * from './math.js';

const TRACKED = '[data-hg~="surface"], [data-hg~="text"]';
const Z_ATTRS = ['data-hg', 'data-hg-z', 'data-hg-z-hover', 'data-hg-z-active'];

const DEFAULTS = {
  root: null, //            element that receives the global --hg-* variables (default <html>)
  mode: 'pointer', //       'pointer' | 'sun' | 'orbit' | 'fixed'
  light: {
    x: 0.5, //              rest position, as a fraction of the viewport
    y: 0.15,
    height: 700, //         px above the page; lower = longer, more dramatic shadows
    color: 5600, //         Kelvin, [r,g,b] or '#hex'
    intensity: 1,
  },
  sun: {
    date: null, //          null = now
    lat: null, //           null = guessed from the time zone, no permission prompt
    lon: null,
    speed: 0, //            simulated seconds per real second (e.g. 1440 = a day per minute)
  },
  shadow: { strength: 1, softness: 1, color: null }, // color null = tinted by the sky
  sky: 35, //               solar altitude used for the sky/shadow tint in non-sun modes
  idle: 'auto', //          pointer mode with no pointer: 'auto' | 'orbit' | 'rest' | 'stay'
  orbit: { speed: 0.25, rx: 0.32, ry: 0.22 },
  smoothing: 7, //          higher = snappier light
  observe: true, //         pick up elements added to the DOM later
};

function merge(base, over) {
  const out = { ...base };
  for (const k in over) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(typeof Node !== 'undefined' && v instanceof Node)
      ? merge(base[k] || {}, v)
      : v;
  }
  return out;
}

const num = (el, attr, fallback) => {
  const v = el.getAttribute(attr);
  return v == null || v === '' ? fallback : parseFloat(v);
};

// Rough location from the UTC offset so 'sun' mode works without geolocation.
function guessLocation() {
  const lon = clamp((-new Date().getTimezoneOffset() / 60) * 15, -180, 180);
  return { lat: 36, lon };
}

const noopScene = () => {
  const s = { set: () => s, setTime: () => s, add: () => s, remove: () => s, refresh: () => s, on: () => () => {}, destroy() {}, light: null };
  return s;
};

/**
 * Light the page.
 * @param {Partial<typeof DEFAULTS>} options
 */
export function createScene(options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return noopScene();

  let opts = merge(DEFAULTS, options);
  const root = opts.root || document.documentElement;
  const abort = new AbortController();
  const { signal } = abort;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const noHover = window.matchMedia('(hover: none)');
  const listeners = { frame: new Set() };

  const items = new Map(); // el -> state
  const visible = new Set();
  let raf = 0, last = 0, dirty = true, clock = 0;
  let pointer = null, pointerAt = -1e9;
  let simTime = opts.sun.date ? +opts.sun.date : Date.now();
  let realTimeTimer = 0;

  // Smoothed light state. `cur` follows `target`; `prev` is used to cross-fade when the kind changes.
  let target = null, cur = null, prev = null, fade = 1;

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
        markDirty();
      }, { rootMargin: '25% 0px' })
    : null;

  function readConfig(el, st) {
    const tokens = (el.getAttribute('data-hg') || '').split(/\s+/);
    st.surface = tokens.includes('surface');
    st.text = tokens.includes('text');
    st.z = num(el, 'data-hg-z', st.text && !st.surface ? 3 : 8);
    st.zHover = num(el, 'data-hg-z-hover', st.z);
    st.zActive = num(el, 'data-hg-z-active', Math.max(0, st.z * 0.4));
    if (st.zCur == null) st.zCur = st.z;
  }

  function add(el) {
    if (items.has(el)) return api;
    const st = { zCur: null, hover: false, active: false, cache: {} };
    readConfig(el, st);
    items.set(el, st);
    const o = { signal };
    el.addEventListener('pointerenter', () => { st.hover = true; kick(); }, o);
    el.addEventListener('pointerleave', () => { st.hover = false; st.active = false; kick(); }, o);
    el.addEventListener('pointerdown', () => { st.active = true; kick(); }, o);
    el.addEventListener('pointerup', () => { st.active = false; kick(); }, o);
    if (io) io.observe(el); else visible.add(el);
    markDirty();
    return api;
  }

  function remove(el) {
    if (!items.has(el)) return api;
    items.delete(el);
    visible.delete(el);
    if (io) io.unobserve(el);
    for (const p of ['--hg-shadow', '--hg-text-shadow', '--hg-lx', '--hg-ly', '--hg-spec', '--hg-angle', '--hg-facing', '--hg-z']) el.style.removeProperty(p);
    return api;
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(TRACKED)) add(node);
    node.querySelectorAll(TRACKED).forEach(add);
  }

  const mo = opts.observe && 'MutationObserver' in window
    ? new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes') {
            const el = r.target;
            if (el.matches(TRACKED)) items.has(el) ? (readConfig(el, items.get(el)), markDirty()) : add(el);
            else if (items.has(el)) remove(el);
            continue;
          }
          r.addedNodes.forEach(scan);
          r.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (items.has(n)) remove(n);
            n.querySelectorAll?.(TRACKED).forEach(remove);
          });
        }
      })
    : null;

  // ---- light targets ------------------------------------------------------

  function restPoint() {
    return { x: opts.light.x * window.innerWidth, y: opts.light.y * window.innerHeight };
  }

  function idleBehaviour() {
    if (opts.idle !== 'auto') return opts.idle;
    return noHover.matches && !reduced.matches ? 'orbit' : 'stay';
  }

  function orbitPoint(t) {
    const w = window.innerWidth, h = window.innerHeight, o = opts.orbit;
    const a = t * o.speed;
    return { x: (opts.light.x + Math.cos(a) * o.rx) * w, y: (opts.light.y + 0.2 + Math.sin(a) * o.ry) * h };
  }

  function pointTarget() {
    const color = parseColor(opts.light.color);
    const sky = skyAt(opts.sky);
    const base = {
      kind: 'point', h: opts.light.height, intensity: opts.light.intensity, color,
      top: sky.top, bottom: sky.bottom, shadow: sky.shadow, altitude: opts.sky,
    };
    let p;
    if (opts.mode === 'orbit') p = orbitPoint(reduced.matches ? 0 : clock);
    else if (opts.mode === 'fixed') p = restPoint();
    else {
      const idleFor = clock - pointerAt;
      const idle = idleBehaviour();
      if (pointer && (idleFor < 3 || idle === 'stay')) p = pointer;
      else if (idle === 'orbit') p = orbitPoint(clock);
      else p = restPoint();
    }
    return { ...base, x: p.x, y: p.y };
  }

  function sunTarget() {
    const loc = guessLocation();
    const lat = opts.sun.lat ?? loc.lat, lon = opts.sun.lon ?? loc.lon;
    const { altitude, azimuth } = sunPosition(new Date(simTime), lat, lon);
    const sky = skyAt(altitude);
    let dir = azimuthToScreen(azimuth, lat), alt = altitude;
    if (altitude < -2) {
      // After dusk the light comes from the opposite side: call it the moon.
      dir = { x: -dir.x, y: -dir.y };
      alt = 38;
    }
    return {
      kind: 'dir', dx: dir.x, dy: dir.y, altitude: alt, sunAltitude: altitude, azimuth,
      intensity: sky.intensity * opts.light.intensity, color: sky.color,
      top: sky.top, bottom: sky.bottom, shadow: sky.shadow, time: new Date(simTime),
    };
  }

  function stepLight(dt) {
    if (opts.mode === 'sun') {
      if (opts.sun.speed) simTime += dt * 1000 * opts.sun.speed;
    }
    target = opts.mode === 'sun' ? sunTarget() : pointTarget();
    if (!cur) { cur = { ...target }; return true; }
    if (cur.kind !== target.kind) {
      prev = { ...cur };
      cur = { ...target };
      fade = 0;
    }
    const t = reduced.matches ? 1 : damp(opts.smoothing, dt);
    let delta = 0;
    const ease = (k, eps) => {
      const d = target[k] - cur[k];
      cur[k] += d * t;
      if (Math.abs(d) > eps) delta++;
    };
    if (cur.kind === 'point') { ease('x', 0.3); ease('y', 0.3); ease('h', 0.3); }
    else {
      ease('dx', 0.001); ease('dy', 0.001); ease('altitude', 0.02);
      const m = Math.hypot(cur.dx, cur.dy) || 1; // keep it a unit vector through the moon flip
      if (m > 0.2) { cur.dx /= m; cur.dy /= m; }
      for (const k of ['sunAltitude', 'azimuth', 'time']) cur[k] = target[k];
    }
    ease('intensity', 0.002);
    for (const k of ['color', 'top', 'bottom', 'shadow']) {
      const before = cur[k];
      cur[k] = mix3(cur[k], target[k], t);
      if (Math.abs(before[0] - target[k][0]) + Math.abs(before[1] - target[k][1]) + Math.abs(before[2] - target[k][2]) > 1) delta++;
    }
    if (fade < 1) { fade = Math.min(1, fade + dt * 2.5); delta++; }
    return delta > 0;
  }

  function stepElevations(dt) {
    let moving = false;
    const t = reduced.matches ? 1 : damp(12, dt);
    for (const st of items.values()) {
      const goal = st.active ? st.zActive : st.hover ? st.zHover : st.z;
      const d = goal - st.zCur;
      if (Math.abs(d) > 0.01) { st.zCur += d * t; moving = true; } else st.zCur = goal;
    }
    return moving;
  }

  // ---- render -------------------------------------------------------------

  function setVar(el, cache, name, value) {
    if (cache[name] === value) return;
    cache[name] = value;
    el.style.setProperty(name, value);
  }

  const rootCache = {};
  const rgbStr = (c) => c.map((v) => Math.round(v)).join(' ');

  function blendIllum(a, b, t) {
    if (t >= 1) return b;
    let da = b.angle - a.angle;
    if (da > 180) da -= 360; else if (da < -180) da += 360;
    return {
      kx: lerp(a.kx, b.kx, t), ky: lerp(a.ky, b.ky, t),
      lx: lerp(a.lx, b.lx, t), ly: lerp(a.ly, b.ly, t),
      spec: lerp(a.spec, b.spec, t), facing: lerp(a.facing, b.facing, t),
      angle: (a.angle + da * t + 360) % 360,
    };
  }

  function render() {
    const L = cur;
    const shadowRgb = opts.shadow.color ? parseColor(opts.shadow.color) : L.shadow;
    const pt = L.kind === 'point' ? { x: L.x, y: L.y } : {
      x: window.innerWidth / 2 + L.dx * window.innerWidth * 0.6,
      y: window.innerHeight / 2 + L.dy * window.innerHeight * 0.6,
    };
    setVar(root, rootCache, '--hg-light', rgbStr(L.color));
    setVar(root, rootCache, '--hg-intensity', L.intensity.toFixed(3));
    setVar(root, rootCache, '--hg-light-x', `${pt.x.toFixed(1)}px`);
    setVar(root, rootCache, '--hg-light-y', `${pt.y.toFixed(1)}px`);
    setVar(root, rootCache, '--hg-sky-top', rgbStr(L.top));
    setVar(root, rootCache, '--hg-sky-bottom', rgbStr(L.bottom));
    setVar(root, rootCache, '--hg-shadow-rgb', rgbStr(shadowRgb));
    setVar(root, rootCache, '--hg-night', clamp(-(L.sunAltitude ?? opts.sky) / 12, 0, 1).toFixed(3));

    // Batch all layout reads before any writes.
    const list = [];
    for (const el of visible) {
      const st = items.get(el);
      if (st) list.push([el, st, el.getBoundingClientRect()]);
    }
    const shadowOpts = { rgb: shadowRgb, strength: opts.shadow.strength, softness: opts.shadow.softness, intensity: L.intensity };
    for (const [el, st, rect] of list) {
      const z = st.zCur;
      let il = illuminate(rect, z, L);
      if (fade < 1 && prev) il = blendIllum(illuminate(rect, z, prev), il, fade);
      const c = st.cache;
      if (st.surface) setVar(el, c, '--hg-shadow', boxShadow(il.kx, il.ky, z, shadowOpts));
      if (st.text) setVar(el, c, '--hg-text-shadow', textShadow(il.kx, il.ky, z, shadowOpts));
      setVar(el, c, '--hg-lx', `${il.lx.toFixed(1)}%`);
      setVar(el, c, '--hg-ly', `${il.ly.toFixed(1)}%`);
      setVar(el, c, '--hg-spec', il.spec.toFixed(3));
      setVar(el, c, '--hg-angle', `${il.angle.toFixed(1)}deg`);
      setVar(el, c, '--hg-facing', il.facing.toFixed(3));
      setVar(el, c, '--hg-z', z.toFixed(2));
    }
    const snapshot = { ...L, x: pt.x, y: pt.y };
    listeners.frame.forEach((fn) => fn(snapshot));
  }

  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    clock += dt;
    let moving = stepLight(dt);
    moving = stepElevations(dt) || moving;
    if (moving || dirty) render();
    dirty = false;
    const animated = opts.mode === 'orbit' && !reduced.matches
      || (opts.mode === 'sun' && opts.sun.speed)
      || (opts.mode === 'pointer' && idleBehaviour() === 'orbit' && !reduced.matches)
      || (opts.mode === 'pointer' && clock - pointerAt < 3.2);
    if (moving || animated) kick(); else last = 0;
  }

  function kick() {
    if (!raf && !signal.aborted) raf = requestAnimationFrame(frame);
  }

  function markDirty() { dirty = true; kick(); }

  function syncRealTime() {
    clearInterval(realTimeTimer);
    if (opts.mode === 'sun' && !opts.sun.date && !opts.sun.speed) {
      realTimeTimer = setInterval(() => { simTime = Date.now(); markDirty(); }, 30000);
    }
  }

  // ---- wiring -------------------------------------------------------------

  const passive = { passive: true, signal };
  window.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    pointerAt = clock;
    if (opts.mode === 'pointer') kick();
  }, passive);
  document.documentElement.addEventListener('pointerleave', () => {
    if (idleBehaviour() !== 'stay') { pointer = null; kick(); }
  }, passive);
  window.addEventListener('scroll', markDirty, { ...passive, capture: true });
  window.addEventListener('resize', markDirty, passive);
  reduced.addEventListener?.('change', markDirty, { signal });

  const api = {
    /** Merge new options, e.g. scene.set({ mode: 'sun', sun: { speed: 600 } }). */
    set(next) {
      if (next.sun && 'date' in next.sun && next.sun.date) simTime = +next.sun.date;
      opts = merge(opts, next);
      syncRealTime();
      markDirty();
      return api;
    },
    /** Jump the sun to a Date, or to an hour of today (0-24, fractional ok). */
    setTime(when) {
      if (typeof when === 'number') {
        const d = new Date(simTime);
        d.setHours(0, 0, 0, 0);
        simTime = +d + when * 3600000;
      } else simTime = +when;
      markDirty();
      return api;
    },
    add, remove,
    refresh() { items.forEach((st, el) => readConfig(el, st)); markDirty(); return api; },
    /** Subscribe to every rendered frame: fn(lightState). Returns an unsubscribe function. */
    on(event, fn) {
      listeners[event]?.add(fn);
      return () => listeners[event]?.delete(fn);
    },
    get light() { return cur && { ...cur }; },
    get time() { return new Date(simTime); },
    destroy() {
      abort.abort();
      cancelAnimationFrame(raf);
      clearInterval(realTimeTimer);
      io?.disconnect();
      mo?.disconnect();
      [...items.keys()].forEach(remove);
      for (const k in rootCache) root.style.removeProperty(k);
      root.removeAttribute('data-hg-scene');
    },
  };

  root.setAttribute('data-hg-scene', '');
  document.querySelectorAll(TRACKED).forEach(add);
  mo?.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: Z_ATTRS });
  syncRealTime();
  kick();

  return api;
}

export default createScene;
