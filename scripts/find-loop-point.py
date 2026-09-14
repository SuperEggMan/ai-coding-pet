#!/usr/bin/env python3
"""
给每个视频找最适合的循环切点。

动图是靠首尾帧接上来做无缝循环的。可灵这类工具即使要求"首尾帧都用同一张图",
出来的尾帧也未必真的回到首帧,直接整段用会在循环处看到一次「跳」。
这个脚本逐帧和首帧比像素平均差,挑差异最小的那一帧当切点 —— 那儿接缝最不明显。

用法:
    scripts/find-loop-point.py <视频目录或单个视频> [--fps 12] [--min 1.0]

输出每个视频建议的 DURATION,直接喂给 kling-to-frames.sh:
    DURATION=<值> scripts/kling-to-frames.sh <目录> <输出目录>

注意:差异值是相对的,只用来比同一个视频的不同切点。不同视频之间没有可比性
(画面越复杂基线越高),别拿来判断"这个视频好不好"。
"""

import glob
import os
import shutil
import statistics
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageChops
except ImportError:
    print("需要 pillow: pip3 install pillow")
    sys.exit(1)


def probe_one(path, fps, min_sec):
    tmp = tempfile.mkdtemp(prefix="loop-")
    try:
        # 缩到 160px 再比:够反映动作差异,又快很多
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
             "-vf", f"fps={fps},scale=160:160", os.path.join(tmp, "f%04d.png")],
            capture_output=True, text=True,
        )
        fs = sorted(glob.glob(os.path.join(tmp, "*.png")))
        if len(fs) < 2:
            return None, r.stderr.strip()[:120] or "抽帧失败"
        base = Image.open(fs[0]).convert("RGB")
        floor = int(min_sec * fps)
        scored = []
        for i, f in enumerate(fs):
            if i < floor:
                continue
            d = ImageChops.difference(base, Image.open(f).convert("RGB"))
            scored.append((statistics.mean(d.convert("L").getdata()), i))
        if not scored:
            return None, f"视频太短(不足 {min_sec}s)"
        scored.sort()
        best_score, best_i = scored[0]
        # 只挑"接缝最小"是个陷阱:很多片子各切点得分差不多(动作大的片子基线本来就高),
        # 挑到最小值往往是最长的那个,文件大三倍而观感没区别(实测 done:
        # 5.00s 得 19.82、1.67s 得 20.0,肉眼没差,但 4.0MB vs 1.4MB)。
        # 所以在"和最优差 3% 以内"的候选里挑**最短**的。
        near = [(i, m) for m, i in scored if m <= best_score * 1.03]
        pick_i, pick_m = min(near, key=lambda t: t[0])
        return (pick_i / fps, pick_m, best_i / fps, best_score, len(fs) / fps, scored[:3]), None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(
        fps=12.0,
        min=1.0,
    )
    for i, a in enumerate(sys.argv[1:]):
        if a == "--fps" and i + 2 <= len(sys.argv[1:]):
            opts["fps"] = float(sys.argv[i + 2])
        if a == "--min" and i + 2 <= len(sys.argv[1:]):
            opts["min"] = float(sys.argv[i + 2])
    if not args:
        print(__doc__)
        return 1
    target = args[0]
    if os.path.isdir(target):
        vids = sorted(
            f for ext in ("mp4", "mov", "webm") for f in glob.glob(os.path.join(target, f"*.{ext}"))
        )
    else:
        vids = [target]
    if not vids:
        print(f"{target} 里没有视频")
        return 1
    if not shutil.which("ffmpeg"):
        print("需要 ffmpeg: brew install ffmpeg")
        return 1

    print(f"{'视频':22s} {'原长':>7s} {'建议(短优先)':>13s} {'差':>6s} {'接缝最小处':>11s} {'差':>6s}")
    for v in vids:
        res, err = probe_one(v, opts["fps"], opts["min"])
        name = os.path.basename(v)
        if not res:
            print(f"{name:22s} {'-':>7s} {'-':>13s}   {err}")
            continue
        dur, score, best_dur, best_score, total, _top = res
        flag = "" if abs(dur - best_dur) < 1e-6 else "  ← 省了 %.0f%%" % ((1 - dur / best_dur) * 100)
        print(f"{name:22s} {total:6.2f}s {dur:12.2f}s {score:6.2f} {best_dur:10.2f}s {best_score:6.2f}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
