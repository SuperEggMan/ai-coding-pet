'use strict';

/**
 * 位姿检查台。
 * 一屏摆开全部状态，用来判断「肢体差异够不够大」——这是皮肤迭代时唯一需要看的东西。
 * 跑法：AICP_POSES=1 npm start
 */

import { createRenderer } from './renderers.js';

const skin = await window.pet.loadSkin();

// 标题跟着皮肤走，迭代多套皮肤时才不会看错是哪一套
document.getElementById('sheetTitle').textContent =
  `${skin.name || skin.id} · ${Object.keys(skin.states).length} 态位姿检查台 · kind=${skin.kind}`;

function makeCell(host, stateName, accent, labelText) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.style.setProperty('--cell-accent', accent);

  const box = document.createElement('div');
  box.className = 'box svg-host';
  cell.appendChild(box);

  const st = skin.states[stateName];

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = labelText || st.label || stateName;
  cell.appendChild(nm);

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = stateName;
  cell.appendChild(id);

  const nt = document.createElement('div');
  nt.className = 'nt';
  nt.textContent = `${st.note || ''} · ${st.in.ms}ms`;
  cell.appendChild(nt);

  host.appendChild(cell);

  // 每格一台独立渲染器：直接落到目标位姿并起 loop，不演过渡
  const r = createRenderer(box, skin);
  r.setState(stateName, { immediate: true });
  return r;
}

const grid = document.getElementById('grid');
for (const [name, st] of Object.entries(skin.states)) {
  makeCell(grid, name, st.accent);
}

// 三色对照：同一个 awaiting_grant 位姿，只换主色
const tiers = document.getElementById('tiers');
for (const [tier, color] of Object.entries(skin.tierAccent)) {
  makeCell(tiers, 'awaiting_grant', color, `${skin.tierLabel[tier]}（${tier}）`);
}

window.pet.log('poses ready', Object.keys(skin.states).length, 'states');
