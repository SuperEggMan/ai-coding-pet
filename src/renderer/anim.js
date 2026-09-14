'use strict';

/**
 * 位姿插值引擎。
 *
 * 为什么不用 CSS transition / WAAPI：
 * 状态是随时会被打断的（正在往「复奏」过渡，突然又来一封请奏）。
 * 打断时必须从**当前实际数值**重新起算，否则会看到跳变——这正是竞品
 * 用 sprite 逐帧时那种「GIF 在闪」的观感来源。
 * 自己维护数值模型 + rAF，重定向就是一次快照，代价是每帧写十几个 transform，
 * 对这个体量完全够用。
 */

/** 每个图层的可动属性与默认值。 */
const DEFAULTS = { x: 0, y: 0, r: 0, s: 1, sx: 1, sy: 1, o: 1 };
const KEYS = Object.keys(DEFAULTS);

/** 缓动：把 CSS cubic-bezier(...) 解析成函数，支持 y 越界（回弹）。 */
function parseEasing(spec) {
  if (typeof spec === 'function') return spec;
  const s = String(spec || '').trim();
  if (!s || s === 'linear') return (t) => t;
  const m = s.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (!m) return easeInOutSine;
  return cubicBezier(+m[1], +m[2], +m[3], +m[4]);
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** 标准三次贝塞尔求解：先用牛顿法解 x(t)=target，再取 y(t)。 */
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-6) break;
      t -= err / d;
    }
    // 牛顿法没收敛就退回二分，保证单调
    if (t < 0 || t > 1) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 20; i += 1) {
        const v = calc(t, x1, x2);
        if (Math.abs(v - x) < 1e-6) break;
        if (v < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return calc(t, y1, y2);
  };
}

class PoseEngine {
  /**
   * @param {SVGElement} root 内联进 DOM 的 pet.svg 根节点
   * @param {object} skin skin.json
   */
  constructor(root, skin) {
    this.root = root;
    this.skin = skin;
    this.props = new Set(skin.propLayers || []);

    /** layerName -> Element */
    this.els = new Map();
    for (const el of root.querySelectorAll('[data-layer]')) {
      this.els.set(el.getAttribute('data-layer'), el);
    }

    /** 当前生效数值（唯一事实来源） */
    this.current = new Map();
    for (const name of this.els.keys()) {
      this.current.set(name, this._baseFor(name));
    }

    this.phase = 'idle'; // 'transition' | 'loop'
    this.from = null;
    this.to = null;
    this.startAt = 0;
    this.durationMs = 0;
    this.easing = easeInOutSine;

    this.loopName = null;
    this.loopBase = null;
    this.loopStartAt = 0;

    this.stateName = null;
    this._raf = null;
    this._onSettle = null;

    this._commit(); // 把默认位姿先写进 DOM，避免首帧闪
  }

  /** prop 类图层默认不可见，其余默认可见。 */
  _baseFor(name) {
    return { ...DEFAULTS, o: this.props.has(name) ? 0 : 1 };
  }

  /** 把某状态的 pose 补全成完整数值表。 */
  _resolvePose(stateName) {
    const st = this.skin.states[stateName];
    if (!st) throw new Error(`skin 缺少状态: ${stateName}`);
    const out = new Map();
    for (const name of this.els.keys()) {
      const base = this._baseFor(name);
      const patch = (st.pose && st.pose[name]) || {};
      out.set(name, { ...base, ...pick(patch) });
    }
    return out;
  }

  /**
   * 切到目标状态。可在任意时刻调用，包含过渡进行中。
   * @param {string} stateName
   * @param {{immediate?: boolean, onSettle?: Function}} opts
   */
  setState(stateName, opts = {}) {
    if (!this.skin.states[stateName]) return;
    const st = this.skin.states[stateName];
    this.stateName = stateName;

    const target = this._resolvePose(stateName);

    if (opts.immediate) {
      this.current = target;
      this._commit();
      this._enterLoop(st.loop, target);
      if (opts.onSettle) opts.onSettle();
      this._ensureRaf();
      return;
    }

    // 关键：起点是「此刻屏幕上的样子」，不是上一个状态的目标位姿
    this.from = cloneMap(this.current);
    this.to = target;
    this.durationMs = Math.max(1, (st.in && st.in.ms) || 300);
    this.easing = parseEasing(st.in && st.in.easing);
    this.startAt = performance.now();
    this.phase = 'transition';
    this.loopName = st.loop || null;
    this._onSettle = opts.onSettle || null;

    this._ensureRaf();
  }

  _enterLoop(loopName, base) {
    this.loopName = loopName || null;
    this.loopBase = base ? cloneMap(base) : cloneMap(this.current);
    this.loopStartAt = performance.now();
    this.phase = this.loopName && this.skin.loops[this.loopName] ? 'loop' : 'settled';
  }

  _ensureRaf() {
    if (this._raf != null) return;
    const step = (now) => {
      this._raf = null;
      const busy = this._tick(now);
      if (busy) {
        this._raf = requestAnimationFrame(step);
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  stop() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  /** @returns {boolean} 是否还需要继续跑帧 */
  _tick(now) {
    if (this.phase === 'transition') {
      const raw = Math.min(1, (now - this.startAt) / this.durationMs);
      const k = this.easing(raw);
      for (const [name, to] of this.to) {
        const from = this.from.get(name);
        const cur = this.current.get(name);
        for (const key of KEYS) {
          cur[key] = from[key] + (to[key] - from[key]) * k;
        }
      }
      this._commit();
      if (raw >= 1) {
        this.current = cloneMap(this.to);
        this._commit();
        this._enterLoop(this.loopName, this.to);
        if (this._onSettle) {
          const cb = this._onSettle;
          this._onSettle = null;
          cb();
        }
      }
      return true;
    }

    if (this.phase === 'loop') {
      const loop = this.skin.loops[this.loopName];
      if (!loop) {
        this.phase = 'settled';
        return false;
      }
      const u = ((now - this.loopStartAt) % loop.ms) / loop.ms;
      // 先回到状态基准位姿，再叠加 loop 轨道，避免多个 loop 属性互相污染
      for (const [name, base] of this.loopBase) {
        const cur = this.current.get(name);
        for (const key of KEYS) cur[key] = base[key];
      }
      for (const [name, frames] of Object.entries(loop.tracks || {})) {
        const cur = this.current.get(name);
        if (!cur || !frames.length) continue;
        const v = sampleTrack(frames, u);
        for (const key of Object.keys(v)) cur[key] = v[key];
      }
      this._commit();
      return true;
    }

    return false;
  }

  _commit() {
    for (const [name, el] of this.els) {
      const v = this.current.get(name);
      if (!v) continue;
      el.style.transform =
        `translate(${round(v.x)}px,${round(v.y)}px) rotate(${round(v.r)}deg) ` +
        `scale(${round(v.s * v.sx, 4)},${round(v.s * v.sy, 4)})`;
      el.style.opacity = String(round(v.o, 3));
    }
  }
}

/**
 * 在 loop 关键帧序列上取样。
 * 关键帧沿 u∈[0,1] 均匀分布，段内用 sine 缓动，让循环没有硬折点。
 */
function sampleTrack(frames, u) {
  const n = frames.length;
  if (n === 1) return pick(frames[0]);
  const segLen = 1 / (n - 1);
  let i = Math.min(n - 2, Math.floor(u / segLen));
  const local = easeInOutSine((u - i * segLen) / segLen);
  const a = pick(frames[i]);
  const b = pick(frames[i + 1]);
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? DEFAULTS[k];
    const bv = b[k] ?? DEFAULTS[k];
    out[k] = av + (bv - av) * local;
  }
  return out;
}

/** 只保留引擎认识的属性，挡掉 skin.json 里的手误字段。 */
function pick(obj) {
  const out = {};
  for (const k of KEYS) {
    if (obj && typeof obj[k] === 'number') out[k] = obj[k];
  }
  return out;
}

function cloneMap(m) {
  const out = new Map();
  for (const [k, v] of m) out.set(k, { ...v });
  return out;
}

function round(n, p = 2) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

export { PoseEngine, parseEasing, cubicBezier, sampleTrack, DEFAULTS };
