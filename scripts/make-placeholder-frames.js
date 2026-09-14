'use strict';

/**
 * 生成 frames 模板的占位图，用来先打通「图 → 交叉淡入 → 位姿插值」这条链，
 * 不必等 AIGC 资产就位。真图到手后直接覆盖同名文件即可。
 *
 * 跑法：node scripts/make-placeholder-frames.js
 *
 * 刻意输出 SVG 而不是位图：<img> 一样能加载，且占位图肉眼就能看出
 *   1) 角色是否对齐到 94% 基准线
 *   2) 八态是否真的换了图
 * 这两件事正是接真实资产时最容易出错的地方。
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'skins', '_frames-template', 'frames');

// 每态一个可辨识的轮廓，只用最少的形状表达「肢体差异」
const STATES = {
  idle: { label: '待命', color: '#8f9bb3', body: 'stand', arms: 'down' },
  running: { label: '运行中', color: '#3f7fbf', body: 'lean', arms: 'swing' },
  awaiting_grant: { label: '请奏', color: '#d7382b', body: 'stand', arms: 'up', prop: true },
  awaiting_choice: { label: '请择', color: '#e08b1f', body: 'stand', arms: 'wide' },
  done: { label: '复奏', color: '#2f9e6b', body: 'hop', arms: 'up' },
  stale: { label: '久候', color: '#c2571f', body: 'slump', arms: 'up', prop: true },
  exiting: { label: '请退', color: '#7a6a52', body: 'bow', arms: 'clasp' },
  limp: { label: '瘫', color: '#8f9bb3', body: 'fallen', arms: 'sprawl' },
};

const W = 1024;
const BASELINE = Math.round(W * 0.94); // 脚底基准线，和引擎的 50%/94% 转轴对齐

function svg(id, cfg) {
  const c = cfg.color;
  // 角色高度占画布 78%
  const h = Math.round(W * 0.78);
  const top = BASELINE - h;
  const cx = W / 2;
  const bodyW = Math.round(W * 0.3);

  let torso;
  let head;
  let arms = '';

  const headR = Math.round(h * 0.19);
  const headCy = top + headR + Math.round(h * 0.04);

  if (cfg.body === 'fallen') {
    // 横躺：整体旋转，脚跟仍压在基准线上
    torso = `<g transform="rotate(-74 ${cx} ${BASELINE})">
      <rect x="${cx - bodyW / 2}" y="${BASELINE - h * 0.6}" width="${bodyW}" height="${h * 0.6}" rx="${bodyW * 0.3}" fill="${c}"/>
      <circle cx="${cx}" cy="${BASELINE - h * 0.6 - headR}" r="${headR}" fill="${c}"/>
    </g>`;
    head = '';
  } else {
    const lean = { lean: -8, bow: 22, slump: 6, hop: 0, stand: 0 }[cfg.body] || 0;
    const rise = cfg.body === 'hop' ? -Math.round(h * 0.06) : 0;
    torso = `<g transform="rotate(${lean} ${cx} ${BASELINE}) translate(0 ${rise})">
      <rect x="${cx - bodyW / 2}" y="${headCy + headR * 0.7}" width="${bodyW}" height="${BASELINE - headCy - headR * 0.7}" rx="${bodyW * 0.26}" fill="${c}"/>
      <circle cx="${cx}" cy="${headCy}" r="${headR}" fill="${c}"/>
      ${armPath(cfg.arms, cx, headCy + headR, bodyW, h, c)}
      ${cfg.prop ? propPath(cx, headCy + headR * 1.2, bodyW) : ''}
    </g>`;
    head = '';
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <!-- 占位图：${cfg.label}（${id}）。真图覆盖同名文件即可。透明底，脚底对齐 y=${BASELINE} -->
  <!-- 基准线参考，接真实资产时应删掉 -->
  <line x1="0" y1="${BASELINE}" x2="${W}" y2="${BASELINE}" stroke="#000" stroke-opacity="0.12" stroke-dasharray="12 12" stroke-width="3"/>
  <line x1="${cx}" y1="0" x2="${cx}" y2="${W}" stroke="#000" stroke-opacity="0.08" stroke-dasharray="12 12" stroke-width="3"/>
  ${torso}${head}
  <text x="${cx}" y="${BASELINE + 46}" font-size="44" font-weight="700" text-anchor="middle"
        fill="${c}" font-family="'PingFang SC',sans-serif">${cfg.label}</text>
</svg>
`;
}

function armPath(kind, cx, shoulderY, bodyW, h, c) {
  const len = Math.round(h * 0.26);
  const t = Math.round(bodyW * 0.17);
  const arm = (angle, sign) =>
    `<rect x="${cx + sign * (bodyW / 2) - t / 2}" y="${shoulderY}" width="${t}" height="${len}" rx="${t / 2}" fill="${c}"
       transform="rotate(${angle} ${cx + sign * (bodyW / 2)} ${shoulderY})"/>`;
  switch (kind) {
    case 'up': return arm(-125, -1) + arm(125, 1);
    case 'wide': return arm(-75, -1) + arm(75, 1);
    case 'swing': return arm(-40, -1) + arm(25, 1);
    case 'clasp': return arm(50, -1) + arm(-50, 1);
    case 'sprawl': return arm(-160, -1) + arm(160, 1);
    default: return arm(-8, -1) + arm(8, 1);
  }
}

/** 奏折：验证「道具是否被身体挡住」这类前后关系问题 */
function propPath(cx, y, bodyW) {
  const w = bodyW * 0.9;
  const hh = w * 0.5;
  return `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${hh}" rx="8"
    fill="#fdf6e3" stroke="#c9b48a" stroke-width="5"/>`;
}

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [id, cfg] of Object.entries(STATES)) {
  fs.writeFileSync(path.join(OUT, `${id}.svg`), svg(id, cfg), 'utf8');
  n += 1;
}
console.log(`已写入 ${n} 张占位图 → ${OUT}`);
console.log('提示：skin.json 的 assets 现指向 .svg；换成真实位图后把扩展名改回 .webp。');
