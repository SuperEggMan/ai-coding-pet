'use strict';

/**
 * 渲染器插槽。
 *
 * 美术资产的来源不该绑死在「谁画的」上。皮肤用 kind 声明形态，
 * 这里按 kind 分派，状态机 / 交互 / 窗口逻辑完全不感知美术是什么做的。
 *
 *   layered —— 分层矢量（SVG 图层），位姿逐部件插值。表现力最强，但要有人分层作图。
 *   frames  —— 每状态一张整图（AIGC 生图最容易产出的形态）。
 *               关键：离散图之间用「交叉淡入淡出 + 整体位姿插值」过渡，
 *               而不是直接换图。否则就回到竞品那种「GIF 在闪」的观感。
 *   model3d —— GLB/VRM 模型（AI 生成 3D）。契约已定义，渲染管线待接。
 *
 * 三种形态共用同一套 skin.json 骨架：states / in.ms / in.easing / pose / loops。
 * 差别只在 pose 作用于哪些图层：layered 作用到每个部件，frames 只作用到 figure 与 shadow。
 */

import { PoseEngine } from './anim.js';

/* ============================================================
   layered：分层矢量
   ============================================================ */
class LayeredRenderer {
  constructor(host, skin) {
    host.innerHTML = skin.layers.pet;
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('layered 皮肤缺少 pet.svg 的根 <svg>');
    svg.removeAttribute('id'); // 检查台会注入多份，避免重复 id
    this.engine = new PoseEngine(svg, skin);
  }

  setState(name, opts) {
    this.engine.setState(name, opts);
  }

  stop() {
    this.engine.stop();
  }
}

/* ============================================================
   frames：每状态一张整图
   ============================================================ */
class FramesRenderer {
  constructor(host, skin) {
    this.skin = skin;
    this.assets = skin.assets || {};
    this.fadeMs = 0;
    this.current = null;

    host.innerHTML = '';
    host.classList.add('frames-host');

    // 影子独立一层，跟着位姿缩放，图才有重量
    this.shadow = document.createElement('div');
    this.shadow.className = 'frames-shadow';
    this.shadow.dataset.layer = 'shadow';
    host.appendChild(this.shadow);

    this.figure = document.createElement('div');
    this.figure.className = 'frames-figure';
    this.figure.dataset.layer = 'figure';
    host.appendChild(this.figure);

    // 两层图轮换，用于交叉淡入淡出
    this.slots = [makeImg(), makeImg()];
    this.slots.forEach((im) => this.figure.appendChild(im));
    this.front = 0;

    // 位姿仍然交给同一套插值引擎，只是图层集合小得多
    this.engine = new PoseEngine(host, skin);
  }

  setState(name, opts = {}) {
    this._lastStateName = name;
    const src = this.assets[name] || this.assets.idle;
    const st = (this.skin.states || {})[name] || {};
    const ms = opts.immediate ? 0 : (st.in && st.in.ms) || 300;
    this._swap(src, ms);
    this.engine.setState(name, opts);
  }

  /**
   * 待命小动作帧:状态机仍在原状态,只临时把画面换到一张动作帧
   * (如 idle_chew 咿胡萝卜),到点自动还原到本状态的帧。
   * 状态真的切走了,自动放弃还原(新状态的 setState 自己会换)。
   */
  playFrame(name, holdMs, opts = {}) {
    const src = this.assets[name];
    const base = this._lastStateName;
    if (!src || !base || src === this.current) return false;
    this._swap(src, (opts.immediate ? 0 : opts.ms) ?? 280);
    clearTimeout(this._frameTimer);
    this._frameTimer = setTimeout(() => {
      this._frameTimer = 0;
      if (this._lastStateName === base && this.assets[base]) {
        this._swap(this.assets[base], 300);
      }
    }, holdMs);
    return true;
  }

  /** 换图核心:两层 img 交叉淡入。
   *  不碰位姿引擎 —— playFrame 时体位保持当前状态。 */
  _swap(src, ms) {
    if (!src || src === this.current) return;
    const back = this.slots[1 - this.front];
    const front = this.slots[this.front];
    back.src = src;
    back.style.transition = ms ? `opacity ${ms}ms linear` : 'none';
    front.style.transition = ms ? `opacity ${ms}ms linear` : 'none';
    void back.offsetWidth;
    back.style.opacity = '1';
    front.style.opacity = '0';
    this.front = 1 - this.front;
    this.current = src;
  }

  stop() {
    this.engine.stop();
  }
}

function makeImg() {
  const im = document.createElement('img');
  im.className = 'frames-img';
  im.draggable = false;
  im.alt = '';
  im.style.opacity = '0';
  return im;
}

/* ============================================================
   model3d：待接
   ============================================================ */
class Model3DRenderer {
  constructor(host, skin) {
    // 故意直接失败而不是画个占位方块。
    // 半成品渲染器会让人以为「3D 已经能用了」，比明确报错更糟。
    throw new Error(
      'model3d 渲染器尚未接入。资产契约已定：\n' +
        `  model: ${(skin.model && skin.model.file) || '<未声明>'}（GLB 或 VRM，Y 轴朝上，单位米）\n` +
        '  每个状态需对应一个动画片段名（skin.states[x].clip），\n' +
        '  片段之间用 AnimationMixer.crossFadeTo(state.in.ms) 过渡。\n' +
        '  接入前需先把 three.js 放进本地依赖（CSP 是 script-src self，不能走 CDN）。'
    );
  }
}

const REGISTRY = {
  layered: LayeredRenderer,
  frames: FramesRenderer,
  model3d: Model3DRenderer,
};

/**
 * 按皮肤声明的 kind 造渲染器。
 * @param {HTMLElement} host
 * @param {object} skin
 */
export function createRenderer(host, skin) {
  const kind = skin.kind || 'layered';
  const Impl = REGISTRY[kind];
  if (!Impl) {
    throw new Error(`未知的皮肤形态 kind="${kind}"，可选：${Object.keys(REGISTRY).join(' / ')}`);
  }
  return new Impl(host, skin);
}

export { LayeredRenderer, FramesRenderer, Model3DRenderer, REGISTRY };
