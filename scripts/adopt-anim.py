#!/usr/bin/env python3
"""
把已经转好的动图资产接进 skin.json。

kling-to-frames.sh 只负责产出 `frames/<state>.apng`,剩下两步以前是手改:
  1. `assets.<state>` 的扩展名从 .png 换成 .apng
  2. **删掉 `states.<state>.loop`** —— 图里已经有动作了,再叠引擎的循环
     会变成两套动作打架(比如 running 的 bob 和视频里的颠动)
第 2 步最容易漏,而且漏了以后表现是"抖得有点怪",不会报错,很难联想到原因。
所以做成脚本,按目录里**实际存在**的 .apng 来改,不用记改过哪些。

用法:
    scripts/adopt-anim.py [皮肤目录]        默认 src/skins/yunnuo
    scripts/adopt-anim.py --revert [皮肤目录]   退回静态 .png(loop 从备份恢复)

改动会在 skin.json 里留一份 `_loopBackup`,所以 --revert 能把 loop 原样放回去。
"""

import json
import pathlib
import sys

STATES = [
    "idle",
    "running",
    "awaiting_grant",
    "awaiting_choice",
    "done",
    "stale",
    "exiting",
    "limp",
]


def apng_duration(path):
    """把 apng 每帧的 duration 加起来，得到播一遍要多久（毫秒）。取不到就返回 0。"""
    try:
        from PIL import Image, ImageSequence
    except ImportError:
        return 0
    try:
        im = Image.open(path)
        total = 0
        for f in ImageSequence.Iterator(im):
            total += f.info.get("duration", im.info.get("duration", 0)) or 0
        return int(round(total)) or 0
    except Exception:
        return 0


def find_segments(frames_dir):
    """
    额外动作片段:文件名形如 `<状态>_<后缀>.apng`,比如 running_burst.apng。

    它们不是状态,不参与状态机、也没有 loop 要删,只是挂进 assets 让渲染层
    能在该状态持续期间随机插播(运行中跑几分钟老是同一个循环很假)。
    按目录里**实际存在**的文件登记,所以只出了其中两段也能用。
    """
    if not frames_dir.is_dir():
        return []
    out = []
    for p in sorted(frames_dir.glob("*_*.apng")):
        head = p.stem.split("_")[0]
        if head in STATES and p.stem not in STATES:
            out.append(p.stem)
    return out


def main():
    args = [a for a in sys.argv[1:] if a != "--revert"]
    revert = "--revert" in sys.argv[1:]
    skin_dir = pathlib.Path(args[0] if args else "src/skins/yunnuo")
    manifest = skin_dir / "skin.json"
    if not manifest.exists():
        print(f"找不到 {manifest}")
        return 1

    d = json.loads(manifest.read_text(encoding="utf-8"))
    assets = d.setdefault("assets", {})
    states = d.setdefault("states", {})
    backup = d.setdefault("_loopBackup", {})
    changed = []

    for st in STATES:
        if st not in states:
            continue
        apng = skin_dir / "frames" / f"{st}.apng"
        png = skin_dir / "frames" / f"{st}.png"

        if revert:
            if not png.exists():
                continue
            if assets.get(st) != f"frames/{st}.png":
                assets[st] = f"frames/{st}.png"
                changed.append(f"{st}: → .png")
            if st in backup and "loop" not in states[st]:
                states[st]["loop"] = backup[st]
                changed.append(f"{st}: 恢复 loop={backup[st]}")
            continue

        if not apng.exists():
            continue
        if assets.get(st) != f"frames/{st}.apng":
            assets[st] = f"frames/{st}.apng"
            changed.append(f"{st}: → .apng")
        if "loop" in states[st]:
            backup[st] = states[st].pop("loop")
            changed.append(f"{st}: 删掉 loop={backup[st]}（图里自带动作）")

    # 额外动作片段。没有 loop 要处理(它们不是状态),只挂 / 摘 assets 条目。
    segments = find_segments(skin_dir / "frames")
    if revert:
        # 退回静态时必须把片段摘掉:片段只有 .apng,留着等于让宠物在静态图之间
        # 突然插播一段动图,对不上
        for seg in [k for k in list(assets) if k.split("_")[0] in STATES and k not in STATES]:
            if assets[seg].endswith(".apng"):
                assets.pop(seg)
                changed.append(f"{seg}: 摘掉片段")
    else:
        segmeta = d.setdefault("segments", {})
        for seg in segments:
            if assets.get(seg) != f"frames/{seg}.apng":
                assets[seg] = f"frames/{seg}.apng"
                changed.append(f"{seg}: 挂上片段（该状态期间随机插播）")
            # 顺手把这段的**真实时长**写进 skin.json。
            # 渲染层插播时要按这个时长再淡回主力，硬编码在代码里必然和资产漂移：
            # 短了会把动作切在中间，长了会把整段又播一遍。
            ms = apng_duration(skin_dir / "frames" / f"{seg}.apng")
            if ms:
                cur = segmeta.setdefault(seg, {})
                if cur.get("ms") != ms:
                    cur["ms"] = ms
                    changed.append(f"{seg}: 时长 {ms}ms（从 apng 实测）")

    if not changed:
        have = [s for s in STATES if (skin_dir / "frames" / f"{s}.apng").exists()]
        if revert:
            print("没什么要改的:已经全是静态图了")
        elif have:
            print(f"没什么要改的:{', '.join(have)} 已经接好了")
        else:
            print(f"没什么要改的:{skin_dir}/frames 里还没有 .apng")
        return 0

    manifest.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{manifest} 已更新:")
    for c in changed:
        print("  " + c)
    anim = [s for s in STATES if assets.get(s, "").endswith(".apng")]
    print(f"\n动图状态 {len(anim)}/8: {', '.join(anim) or '无'}")
    still = [s for s in STATES if s in states and not assets.get(s, "").endswith(".apng")]
    if still:
        print(f"还是静态图: {', '.join(still)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
