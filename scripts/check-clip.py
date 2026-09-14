#!/usr/bin/env python3
"""
AIGC 视频片段体检：在进管线之前把废片挡住。

用法：
    scripts/check-clip.py <mp4> [更多 mp4 ...]
    scripts/check-clip.py ~/Downloads/kling            # 目录里所有 mp4

为什么要有这个：一段废片转成 apng、接进皮肤、起 Electron 才发现不对，来回一轮十几分钟；
而下面这些问题全都能在源视频上量出来。实测踩过的每一条都在这儿：

  1. 角色位移      —— 桌宠窗口只有 100px，角色一位移就会在窗口里乱跑
  2. 地面线        —— AI 无视「无地面」画的横线，抠像会把它当主体留成一根横杠
  3. 步频          —— 「快跑」的观感靠它，太慢就是原地抖
  4. 循环切点      —— 首尾不接会看见跳帧；顺带给事件段定位事件窗口
  5. 深色线条被抠穿 —— 深棕在 RGB 空间离暗绿很近，容差稍大眼睛/眉毛就成透视孔
  6. 绿色装饰物    —— AI 硬画的运动弧，绿和绿幕不同所以抠不掉
       · 脱离主体的 → clean-apng.py 能自动清，只提示
       · 贴住主体的 → 治不了，必须重出

两个判据上踩过的坑（写在这儿免得再犯）：

  · **步频必须按源帧率抽帧测**。12fps 抽帧的奈奎斯特上限只有 6Hz，而目标步频 4~8 步/秒，
    8 步/秒会被折叠成 ~1 步/秒，把明显在快跑的片子报成「原地抖」。
  · **「空洞」必须回查源色**。角色的四肢围成闭环时会把一块背景绿圈在里面，
    那是正常抠像结果，不是抠穿。只有「源色本来离绿幕很远、却被抠掉了」才算抠穿。
  · **「贴身绿」必须先腐蚀掉轮廓**。每张图的剪影边缘都有一圈亚像素绿溢色，
    缩到 84px 根本看不见，算进来会把好片子误判成废片。

阈值按「每帧多少像素」算，基准是实测判定可用的第一段 running：空洞 1.4px/帧、贴身绿 9px/帧。

退出码：全过 0；有「必须重出」级别的问题 1。
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, deque

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：pip3 install --user Pillow")
    sys.exit(1)

import numpy as np


def _load_cleaner():
    """
    把 clean-apng.py 的清理逻辑借过来用。

    体检必须量「**过完管线之后**还剩多少」，而不是「刚抠完剩多少」——
    管线里 clean-apng.py 会删掉脱离主体的绿碎块和贴身的细绿笔画，
    不算这一层就会把管线能自动处理的片子误判成废片（实测踩过）。
    文件名带横线不能直接 import，走 importlib。
    """
    import importlib.util
    p = pathlib.Path(__file__).with_name("clean-apng.py")
    if not p.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("clean_apng", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


FPS = float(os.environ.get("FPS", 12))          # 主要判据的抽帧率
SIMILARITY = float(os.environ.get("SIMILARITY", 0.12))
BLEND = float(os.environ.get("BLEND", 0.08))
SIZE = int(os.environ.get("SIZE", 256))
GREEN_MARGIN = 15

OK, WARN, BAD = "✅", "⚠️ ", "❌"
# 判据阈值（px/帧）
HOLE_BAD = 10
ATT_WARN, ATT_BAD = 12, 25
DRIFT_WARN, DRIFT_BAD = 5, 10  # %


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(path):
    r = sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height,r_frame_rate,nb_frames,duration", "-of", "default=nw=1", str(path)])
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


def geom(size):
    """kling-to-frames 用的缩放/补边，抠像前后都套同一套，坐标才能 1:1 对齐。"""
    return (f"scale={size}:{size}:force_original_aspect_ratio=decrease:flags=lanczos"
            f",pad={size}:{size}:(ow-iw)/2:oh-ih:color=0x00000000")


def extract(path, outdir, fps, key=None, size=SIZE):
    outdir.mkdir(parents=True, exist_ok=True)
    vf = f"fps={fps}"
    if key:
        vf += f",colorkey={key}:{SIMILARITY}:{BLEND}"
    vf += f",format=rgba,{geom(size)}"
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
        "-vf", vf, str(outdir / "%03d.png")])
    return sorted(outdir.glob("*.png"))


def bg_color(img):
    a = np.array(img.convert("RGB"))
    h, w = a.shape[:2]
    n = max(6, min(h, w) // 24)
    px = np.vstack([a[:n, :n].reshape(-1, 3), a[:n, -n:].reshape(-1, 3),
                    a[-n:, :n].reshape(-1, 3), a[-n:, -n:].reshape(-1, 3)])
    return np.array(Counter(map(tuple, px)).most_common(1)[0][0], dtype=int)


def components(mask):
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            pts = []
            while q:
                y, x = q.popleft()
                pts.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            out.append(pts)
    out.sort(key=len, reverse=True)
    return out


def flood_outside(solid):
    """从画布四边灌水，标出「与外部连通的透明区域」。"""
    h, w = solid.shape
    out = np.zeros_like(solid)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not solid[y, x] and not out[y, x]:
                out[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not solid[y, x] and not out[y, x]:
                out[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not solid[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out


def erode(mask, r):
    out = mask.copy()
    for _ in range(r):
        e = out.copy()
        e[1:, :] &= out[:-1, :]
        e[:-1, :] &= out[1:, :]
        e[:, 1:] &= out[:, :-1]
        e[:, :-1] &= out[:, 1:]
        out = e
    return out


def check(path):
    name = pathlib.Path(path).name
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")
    info = probe(path)
    if not info:
        print(f"  {BAD} ffprobe 读不了这个文件")
        return False
    dur = float(info.get("duration", 0))
    try:
        num, den = info.get("r_frame_rate", "24/1").split("/")
        srcfps = float(num) / float(den)
    except Exception:
        srcfps = 24.0
    print(f"  {info.get('width')}x{info.get('height')}  {srcfps:.0f}fps  {dur:.2f}s  {info.get('nb_frames','?')} 帧")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="clipchk"))
    fatal = False
    try:
        raws = extract(path, tmp / "raw", FPS)
        if not raws:
            print(f"  {BAD} 抽帧失败")
            return False
        bg = bg_color(Image.open(raws[0]))
        key = "0x%02X%02X%02X" % tuple(bg)
        print(f"\n  绿幕色（首帧四角取样）= {key}   与提示词里的 #00B140 差 {abs(bg - np.array([0,177,64])).sum()}")

        # ---------- 位移 / 地面线 ----------
        cx, bot, ground = [], [], 0
        rawarr = []
        for f in raws:
            a = np.array(Image.open(f).convert("RGB")).astype(int)
            rawarr.append(a)
            m = np.abs(a - bg).sum(axis=2) > 90
            ys, xs = np.nonzero(m)
            if not len(ys):
                continue
            cx.append((xs.min() + xs.max()) / 2)
            bot.append(ys.max())
            for y in range(max(0, ys.max() - 4), ys.max() + 1):
                sp = np.nonzero(m[y])[0]
                if len(sp) and (sp.max() - sp.min() + 1) > m.shape[1] * 0.5 \
                        and m[y].sum() / (sp.max() - sp.min() + 1) > 0.85:
                    ground += 1
                    break
        drift = (max(cx) - min(cx)) / SIZE * 100
        wave = (max(bot) - min(bot)) / SIZE * 100
        tag = OK if drift < DRIFT_WARN else (WARN if drift < DRIFT_BAD else BAD)
        print(f"  {tag}位移：水平漂移 {drift:.1f}%  脚底波动 {wave:.1f}%"
              f"{'   角色会在窗口里乱跑，重出' if drift >= DRIFT_BAD else ''}")
        if drift >= DRIFT_BAD:
            fatal = True
        tag = OK if ground == 0 else (WARN if ground < len(raws) * 0.3 else BAD)
        print(f"  {tag}地面线：{ground}/{len(raws)} 帧命中{'   会被抠成一根横杠' if ground else ''}")
        if ground >= len(raws) * 0.3:
            fatal = True

        # ---------- 步频 / 循环切点（必须源帧率，否则混叠） ----------
        his = extract(path, tmp / "hi", srcfps)
        hmask, hspan = [], []
        for f in his:
            a = np.array(Image.open(f).convert("RGB")).astype(int)
            m = np.abs(a - bg).sum(axis=2) > 90
            hmask.append(m)
            _, lx = np.nonzero(m[int(SIZE * 0.72):])
            hspan.append(lx.max() - lx.min() + 1 if len(lx) else 0)
        s = np.array(hspan, float)
        if len(s) > 8 and s.max() > s.min():
            sg = np.sign(s - s.mean())
            sg[sg == 0] = 1
            rate = int((np.diff(sg) != 0).sum()) / 2 / (len(s) / srcfps)
            tag = OK if rate >= 3 else (WARN if rate >= 2 else BAD)
            print(f"  {tag}步频：约 {rate:.1f} 步/秒（按源帧率 {srcfps:.0f}fps 测；要 4~5）")
        ref = hmask[0]
        diffs = [int(np.logical_xor(hmask[i], ref).sum()) for i in range(len(hmask))]
        lo = int(srcfps * 0.4)
        cand = sorted(((i, diffs[i]) for i in range(lo, len(hmask))), key=lambda x: x[1])[:3]
        print("  循环切点：" + "  ".join(f"t={i/srcfps:.2f}s(差{v})" for i, v in cand))
        print(f"     → 主力循环用 DURATION={cand[0][0]/srcfps:.2f}")
        peak = int(np.argmax(diffs))
        if diffs[peak] > cand[0][1] * 4:
            a0 = max(0.0, peak / srcfps - 1.2)
            a1 = min(len(hmask) / srcfps, peak / srcfps + 1.2)
            print(f"     → 若是事件段：动作最猛在 t={peak/srcfps:.2f}s，"
                  f"用 START={a0:.1f} DURATION={a1-a0:.1f} 把事件包住")

        # ---------- 抠像后：空洞 / 绿装饰 ----------
        keys = extract(path, tmp / "kd", FPS, key=key)
        holes = detached = attached = 0
        n = max(1, len(keys))
        cleaner = _load_cleaner()
        for kf, rawa in zip(keys, rawarr):
            a = np.array(Image.open(kf).convert("RGBA"))
            solid = a[:, :, 3] > 60
            if not solid.any():
                continue
            outside = flood_outside(solid)
            hole = (~solid) & (~outside)
            if hole.any():
                # 只算「源色本来离绿幕很远、却被抠掉了」的洞。
                # 四肢围成闭环时圈住的那块背景绿是正常结果，不算抠穿。
                hy, hx = np.nonzero(hole)
                d = np.sqrt(((rawa[hy, hx] - bg) ** 2).sum(axis=1)) / 441
                holes += int((d > 0.22).sum())
            comps = components(solid)
            main = np.zeros_like(solid)
            for y, x in comps[0]:
                main[y, x] = True
            # 绿装饰按**源色**判：源色偏绿又不是绿幕色，就是 AI 画上去的绿
            rd = rawa.astype(int)
            paint = ((rd[:, :, 1] > rd[:, :, 0] + GREEN_MARGIN)
                     & (rd[:, :, 1] > rd[:, :, 2] + GREEN_MARGIN)
                     & (np.sqrt(((rd - bg) ** 2).sum(axis=2)) / 441 > 0.10))
            for pts in comps[1:]:
                ys = np.fromiter((p[0] for p in pts), int)
                xs = np.fromiter((p[1] for p in pts), int)
                if paint[ys, xs].mean() >= 0.6:
                    detached += len(pts)
            # 贴身绿要量「过完 clean-apng 三刀之后还剩多少」，否则会把
            # 管线能自动清掉的片子误判成废片
            after = a
            if cleaner is not None:
                try:
                    after = cleaner.clean_frame(a)[0]
                except Exception:
                    after = a
            am = after[:, :, 3] > 60
            if not am.any():
                continue
            comps2 = components(am)
            main2 = np.zeros_like(am)
            for y, x in comps2[0]:
                main2[y, x] = True
            inner = erode(main2, 2)   # 剥掉轮廓溢色
            ys, xs = np.nonzero(main2)
            top, bt = ys.min(), ys.max()
            zone = np.zeros_like(am)
            zone[top + int((bt - top) * 0.5):] = True   # 角色自己的绿只长在头上
            attached += int((inner & paint & zone & (after[:, :, 3] > 150)).sum())

        hp, ap = holes / n, attached / n
        tag = OK if hp < HOLE_BAD else BAD
        print(f"\n  {tag}深色线条：真被抠穿 {hp:.1f}px/帧（合计 {holes}）"
              f"{'   眼睛/眉毛/嘴成了透视孔，收紧 SIMILARITY' if hp >= HOLE_BAD else ''}")
        if hp >= HOLE_BAD:
            fatal = True
        tag = OK if detached == 0 else WARN
        print(f"  {tag}脱离主体的绿装饰：{detached/n:.0f}px/帧"
              f"{'   clean-apng.py 自动清，不用重出' if detached else ''}")
        tag = OK if ap < ATT_WARN else (WARN if ap < ATT_BAD else BAD)
        note = "   清不掉，建议重出" if ap >= ATT_BAD else ("   有一点，84px 下大概看不出" if ap >= ATT_WARN else "")
        src = "已算上 clean-apng 三刀" if cleaner else "⚠️ 没加载到 clean-apng，这个数偏高"
        print(f"  {tag}贴住身体的绿装饰：{ap:.0f}px/帧（下半身，剥掉轮廓，{src}）{note}")
        if ap >= ATT_BAD:
            fatal = True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n  结论：{'❌ 建议重出' if fatal else '✅ 可以进管线'}")
    return not fatal


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip())
        return 1
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("需要 ffmpeg：brew install ffmpeg")
        return 1
    clips = []
    for a in args:
        p = pathlib.Path(a)
        if p.is_dir():
            for ext in ("mp4", "mov", "webm"):
                clips.extend(sorted(p.glob(f"*.{ext}")))
        elif p.exists():
            clips.append(p)
        else:
            print(f"路径不存在：{a}")
    if not clips:
        print("没找到视频")
        return 1
    allok = True
    for c in clips:
        allok &= check(c)
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
