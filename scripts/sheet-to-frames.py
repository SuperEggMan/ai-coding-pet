#!/usr/bin/env python3
"""
角色动作设定表 → 八张对齐好的桌宠资产。

输入：一张 2 行 x 4 列的设定表（AIGC 一次生成，八态画风天然一致）
输出：八张 1024x1024 透明 PNG，脚底全部对齐同一条基准线

用法：
    python3 scripts/sheet-to-frames.py <设定表.png> <输出目录>
    python3 scripts/sheet-to-frames.py ~/Downloads/sheet.png src/skins/yunnuo/frames

选项（环境变量）：
    KEY=00B140      绿幕色，十六进制。设 KEY=none 表示图已带透明通道
    TOL=90          抠像容差，绿边残留就调大（0-255）
    COLS=4 ROWS=2   设定表的网格
    SIZE=1024       输出边长
    BASELINE=0.94   脚底落在画布高度的哪个位置
    FIGURE=0.78     以 idle 为基准，角色高度占画布的比例

做了什么值得说明的事：
  1. 全局统一缩放 —— 八格用同一个缩放系数，而不是各自缩放到等高。
     否则「瘫」被拉回和「待命」一样高，刻意做的压扁拉长差异就全毁了。
  2. 逐格底部对齐 —— 每格按自己的 alpha 外接框底边对齐基准线。
     这是消除「状态切换时角色上下跳」的关键，AIGC 不可能自己对齐这么准。
"""

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 行优先，必须和提示词里写的顺序一致
ORDER = [
    "idle", "running", "awaiting_grant", "awaiting_choice",
    "done", "stale", "exiting", "limp",
]

KEY = os.environ.get("KEY", "00B140")
TOL = int(os.environ.get("TOL", "90"))
COLS = int(os.environ.get("COLS", "4"))
ROWS = int(os.environ.get("ROWS", "2"))
SIZE = int(os.environ.get("SIZE", "1024"))
BASELINE = float(os.environ.get("BASELINE", "0.94"))
FIGURE = float(os.environ.get("FIGURE", "0.78"))


def die(msg):
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


def key_out_green(rgba: np.ndarray, key_rgb, tol: int) -> np.ndarray:
    """把接近绿幕色的像素打成透明，并压掉主体边缘吃到的绿反光。"""
    # 必须用 int32：int16 下 255**2 会溢出，sqrt 拿到负数就抠错了
    rgb = rgba[:, :, :3].astype(np.int32)
    dist = np.sqrt(((rgb - np.array(key_rgb, dtype=np.int32)) ** 2).sum(axis=2))
    out = rgba.copy()
    out[:, :, 3] = np.where(dist < tol, 0, out[:, :, 3])

    # despill：半透明边缘上绿通道压到红蓝的均值，不做会留一圈绿边
    edge = (out[:, :, 3] > 0) & (dist < tol * 2.2)
    if edge.any():
        r = out[:, :, 0].astype(np.int32)
        g = out[:, :, 1].astype(np.int32)
        b = out[:, :, 2].astype(np.int32)
        cap = (r + b) // 2
        out[:, :, 1] = np.where(edge & (g > cap), cap, g).astype(np.uint8)
    return out


def alpha_bbox(rgba: np.ndarray, thresh: int = 12):
    """alpha 外接框。返回 (left, top, right, bottom)，全透明则返回 None。"""
    a = rgba[:, :, 3]
    ys, xs = np.where(a > thresh)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src = Path(sys.argv[1]).expanduser()
    out_dir = Path(sys.argv[2]).expanduser()
    if not src.exists():
        die(f"找不到设定表 {src}")
    out_dir.mkdir(parents=True, exist_ok=True)

    sheet = Image.open(src).convert("RGBA")
    W, H = sheet.size
    if W % COLS or H % ROWS:
        print(f"提示：设定表 {W}x{H} 不能被 {COLS}x{ROWS} 整除，切格会有几像素误差")
    cw, ch = W // COLS, H // ROWS
    print(f"设定表 {W}x{H} → {ROWS}行{COLS}列，每格 {cw}x{ch}")

    if len(ORDER) != ROWS * COLS:
        die(f"状态数 {len(ORDER)} 与网格 {ROWS}x{COLS} 不符")

    key_rgb = None
    if KEY.lower() != "none":
        h = KEY.lstrip("#")
        if len(h) != 6:
            die(f"KEY 要是六位十六进制，当前是 {KEY}")
        key_rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    # 第一遍：切格、抠像、量外接框
    cells = []
    for idx, name in enumerate(ORDER):
        r, c = divmod(idx, COLS)
        cell = np.array(sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)))
        if key_rgb is not None:
            cell = key_out_green(cell, key_rgb, TOL)
        box = alpha_bbox(cell)
        if box is None:
            print(f"  警告 {name}：这一格抠完全透明，可能抠像容差太大或该格是空的")
        cells.append((name, cell, box))

    # 用 idle 定全局缩放；八格共用同一系数，才能保住刻意做的大小差异
    ref = next((b for n, _, b in cells if n == "idle" and b), None)
    if ref is None:
        ref = next((b for _, _, b in cells if b), None)
    if ref is None:
        die("八格全是空的，检查抠像色和容差")
    ref_h = ref[3] - ref[1]
    scale = (SIZE * FIGURE) / ref_h
    print(f"以 idle 为基准：主体高 {ref_h}px → 缩放 {scale:.3f}")

    baseline_y = int(SIZE * BASELINE)
    written = 0

    for name, cell, box in cells:
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        if box:
            sub = Image.fromarray(cell).crop(box)
            nw = max(1, int(round(sub.width * scale)))
            nh = max(1, int(round(sub.height * scale)))
            sub = sub.resize((nw, nh), Image.LANCZOS)
            # 底边贴基准线、水平居中：状态切换时才不会上下跳
            canvas.alpha_composite(sub, (int((SIZE - nw) / 2), baseline_y - nh))
            info = f"{nw}x{nh}"
        else:
            info = "空"

        dst = out_dir / f"{name}.png"
        canvas.save(dst, optimize=True)
        kb = dst.stat().st_size // 1024
        print(f"  ok  {name:<16} {info:>11}  {kb} KB")
        written += 1

    print(f"\n已写入 {written} 张 → {out_dir}")
    print("下一步：")
    print("  1. skin.json 的 assets 扩展名改成 .png")
    print(f"  2. AICP_SKIN={out_dir.parent.name} npm run poses   # 看八态差异与对齐")
    print(f"  3. AICP_SKIN={out_dir.parent.name} npm run demo    # 看过渡有没有闪")


if __name__ == "__main__":
    main()
