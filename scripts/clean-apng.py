#!/usr/bin/env python3
"""
抠像后的收尾清理：删掉「脱离主体的绿色碎块」。

为什么需要这一步（实测踩到的）：
    AIGC 出的视频里会自己加运动弧线、尘土、地面线之类的装饰，即使反向提示词
    明确写了「速度线, 尘土, 地面」也照样画。这些东西的绿**和绿幕不是同一个绿**
    （实测某段视频里的运动弧是 RGB(112,168,128)，绿幕是 RGB(6,144,64)，
    归一距离 0.303），所以抠像抠不掉，最后就是桌面上飘着一个绿月牙。

    收紧抠像容差治不了它，反而会把角色的深色线条（眼睛、眉毛、嘴）一起抠穿
    —— 深棕在 RGB 欧氏空间里离暗绿比直觉近得多（RGB(93,69,63) 到绿幕只有 0.32）。
    所以只能在抠完之后按「连通性 + 颜色」把它挑出来删。

判据（两条都满足才删，尽量不误伤）：
    ① 这一块和主体（最大连通块）**不相连**；
    ② 这一块**绝大多数像素偏绿**。

    第 ② 条是关键的保险。角色自己的绿（薄荷色耳朵、头顶毛）永远和身体连在一起，
    不会被判成独立块；而 running_wipe 段里刻意甩出的汗珠是白/蓝的，不偏绿，
    所以会被保留。真正被删的只有绿色装饰残留。

    不偏绿的独立块会**保留并告警**——那可能是角色真的甩出去的部件，
    也可能是别的垃圾，交给人看一眼再决定，脚本不擅自删。

用法：
    scripts/clean-apng.py <apng 文件或目录> [...]
    scripts/clean-apng.py src/skins/yunnuo/frames
    DRY=1 scripts/clean-apng.py ...      # 只报告不改文件
"""

import os
import pathlib
import sys
from collections import deque

try:
    from PIL import Image, ImageSequence
except ImportError:
    print("需要 Pillow：pip3 install --user Pillow")
    sys.exit(1)

import numpy as np

ALPHA_TH = int(os.environ.get("ALPHA_TH", 60))  # 多大 alpha 才算实体
MIN_BLOB = int(os.environ.get("MIN_BLOB", 12))  # 小于这个的碎点一律删（抠像毛刺）
GREEN_MARGIN = int(os.environ.get("GREEN_MARGIN", 15))  # G 比 R/B 高多少算偏绿
GREEN_RATIO = float(os.environ.get("GREEN_RATIO", 0.6))  # 块内偏绿像素占比阈值
FAR_PAD = int(os.environ.get("FAR_PAD", 4))  # 离主体多少像素外的淡绿一律扫掉
# 「细绿笔画」判据：贴在角色身上的绿色装饰弧线。用**填充率**（面积/包围盒）区分它和
# 角色自己的绿：实测耳朵/头顶毛的填充率 28%~51%，而运动弧只有 9%~17%（细长曲线）。
# 阈值 22% 落在两者之间，两边都有余量。不用「在身体哪个高度」当判据 ——
# limp 是摊平躺着的，耳朵会落到画面下半部分，按高度划区会把耳朵擦掉。
# 第三刀「删细绿笔画」**默认关**（0 = 不启用），只在需要时按段打开：
#   STROKE_FILL=0.22 scripts/kling-to-frames.sh ...
# 它抓的是贴在腿上的绿色运动弧（填充率 9%~17%，而耳朵/头顶毛是 28%~51%）。
# 但 exiting（深鞠躬、只露头顶）的头毛发丝同样细长，会被一起删掉、在头毛里挖出
# 539px 的洞（实测）。两者的面积区间完全重叠（发丝 158~190px，运动弧 22~594px），
# 靠面积分不开，所以不做自动判断 —— 谁需要谁自己开。
# 目前只有 running 那几段的素材里有运动弧。
STROKE_FILL = float(os.environ.get("STROKE_FILL", 0))
STROKE_MIN = int(os.environ.get("STROKE_MIN", 20))
# ---------------------------------------------------------------------------
# 【试过并撤掉】按「绿主导度」去绿溢色的第四刀
#
# 想法是：溢色和运动模糊混色的绿饱和度明显高于角色自己的绿
# （实测 绿幕本体 0.59 / 运动模糊尾迹 0.21 / 薄荷耳朵 0.075 / 头顶毛 0.116，
#  绿主导度 = (G - max(R,B)) / G），所以按 >0.15 就能挑出来删。
#
# **实现过三个版本，全部撤除**，记在这儿免得再走一遍：
#   ① 无约束全删 → 在 exiting（深鞠躬、只露头顶）的薄荷绿头毛里挖出 556px 的洞，
#      因为夹在发丝之间的暗部 RGB(73,120,85) 主导度 0.28~0.42，也被当溢色了。
#   ② 只在「离透明区 N px」的带子里删 → 带子窄了清不掉贴腿的粗弧，
#      宽了照样挖洞，两头不讨好。
#   ③ 按连通性判「这块绿里有没有足量薄荷本色」→ 更糟，running_glance 的绿
#      直接掉了 98.5%（耳朵整块被删），因为小面积的耳朵凑不够阈值。
#
# 撤除的判断依据：这一刀真正想解决的只有两样 ——
#   · 1px 轮廓溢色：**84px 下是亚像素，看不见**（本项目一贯取舍：
#     宁可留看不见的绿边，不要肉眼可辨的错色）
#   · v4 那条运动模糊尾迹：单独一段的问题，收窄取样窗口或直接接受即可
# 而所有**看得见**的绿弧，规则 1~3 已经能处理。为这点收益反复在角色身上冒挖洞的风险，
# 不值。真要再做，得先有「哪些像素属于角色」的可靠依据，而不是靠颜色统计猜。
# ---------------------------------------------------------------------------
DRY = os.environ.get("DRY") == "1"


def components(mask):
    """8 邻域连通块，返回按面积降序的坐标列表。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for sy in range(h):
        row = mask[sy]
        for sx in range(w):
            if not row[sx] or seen[sy, sx]:
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


def dilate(mask, r):
    """膨胀 r 圈（十字邻域够用，只是拿来划一条"贴着主体"的安全带）。"""
    out = mask.copy()
    for _ in range(r):
        d = np.zeros_like(out)
        d[1:, :] |= out[:-1, :]
        d[:-1, :] |= out[1:, :]
        d[:, 1:] |= out[:, :-1]
        d[:, :-1] |= out[:, 1:]
        out |= d
    return out


def clean_frame(rgba):
    """返回 (清理后的数组, 删掉的块列表, 保留但可疑的块列表, 扫掉的淡绿像素数)。"""
    a = rgba.copy()
    mask = a[:, :, 3] > ALPHA_TH
    if not mask.any():
        return a, [], [], 0
    comps = components(mask)
    removed, suspicious = [], []
    for pts in comps[1:]:  # comps[0] 是主体，永不动
        ys = np.fromiter((p[0] for p in pts), int)
        xs = np.fromiter((p[1] for p in pts), int)
        px = a[ys, xs, :3].astype(int)
        greenish = ((px[:, 1] > px[:, 0] + GREEN_MARGIN) & (px[:, 1] > px[:, 2] + GREEN_MARGIN)).mean()
        info = (len(pts), greenish, int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max()))
        if len(pts) < MIN_BLOB or greenish >= GREEN_RATIO:
            a[ys, xs, 3] = 0  # 只清 alpha，颜色留着无所谓
            removed.append(info)
        else:
            suspicious.append(info)

    # 第二刀：连通块判据只覆盖 alpha > ALPHA_TH 的像素，而那些绿装饰的**半透明外圈**
    # （实测 alpha 中位数 3、最高 57）漏在外面，缩到 84px 后仍能看出一圈淡淡的弧。
    # 这些像素的特征非常干净：离主体有距离 + 明显偏绿。角色自己的绿（薄荷耳朵、
    # 头顶毛）永远贴着身体，所以按"离主体多远"就能把两者分开。
    main = np.zeros_like(mask)
    for y, x in comps[0]:
        main[y, x] = True
    safe = dilate(main, FAR_PAD)
    rgb = a[:, :, :3].astype(int)
    faint = (
        (a[:, :, 3] > 0)
        & (~safe)
        & (rgb[:, :, 1] > rgb[:, :, 0] + GREEN_MARGIN)
        & (rgb[:, :, 1] > rgb[:, :, 2] + GREEN_MARGIN)
    )
    swept = int(faint.sum())
    if swept:
        a[:, :, 3][faint] = 0

    # 第三刀：**贴在角色身上**的绿色装饰弧线。前两刀都靠"和主体不相连"，
    # 而运动弧的一头常常搭在腿上，连通性判不出来。这里改用形状：
    # 对身体内部的绿色区域各自求连通块，细长的（填充率低）就是画上去的笔画。
    # 实测这些像素 99.6% 落在主体外圈 3px 之内，所以直接清 alpha 不会在腿上打洞。
    body = a[:, :, 3] > 150
    green = (
        body
        & (rgb[:, :, 1] > rgb[:, :, 0] + GREEN_MARGIN)
        & (rgb[:, :, 1] > rgb[:, :, 2] + GREEN_MARGIN)
    )
    stroke = 0
    killed = np.zeros_like(body)
    if green.any():
        for pts in components(green):
            if len(pts) < STROKE_MIN:
                continue
            ys = np.fromiter((p[0] for p in pts), int)
            xs = np.fromiter((p[1] for p in pts), int)
            bb = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
            if bb and len(pts) / bb < STROKE_FILL:
                a[ys, xs, 3] = 0
                killed[ys, xs] = True
                stroke += len(pts)
    # 笔画的**半透明软边**（alpha 低于上面那个 150 的门槛）不会被上面删到，
    # 留下来是一圈淡淡的虚点弧。只在刚删掉的笔画周围两像素内扫，
    # 范围限得死，不会碰到远处角色自己的绿。
    if killed.any():
        near = dilate(killed, 2)
        halo = (
            near
            & (a[:, :, 3] > 0)
            & (rgb[:, :, 1] > rgb[:, :, 0] + GREEN_MARGIN)
            & (rgb[:, :, 1] > rgb[:, :, 2] + GREEN_MARGIN)
        )
        stroke += int(halo.sum())
        a[:, :, 3][halo] = 0

    # 第四刀：**运动模糊和绿幕的混色**。判据是绿饱和度而不是形状或位置，
    # 所以粗的、细的、贴身的、脱离的一概能抓，而且跟姿态无关。
    # 顺带把剪影边缘那一圈亚像素绿溢色也一起去掉（等效于一次只作用在绿上的 despill，
    # 不会像 ffmpeg 的全局 despill 那样把薄荷绿耳朵洗成灰蓝）。
    return a, removed, suspicious, swept + stroke


def process(path):
    im = Image.open(path)
    frames, durations = [], []
    for f in ImageSequence.Iterator(im):
        frames.append(np.array(f.convert("RGBA")))
        durations.append(f.info.get("duration", im.info.get("duration", 83)))

    out_frames = []
    tot_removed = tot_px = tot_faint = 0
    sus = []
    for i, arr in enumerate(frames):
        cleaned, removed, suspicious, swept = clean_frame(arr)
        out_frames.append(Image.fromarray(cleaned))
        tot_removed += len(removed)
        tot_px += sum(r[0] for r in removed)
        tot_faint += swept
        for s in suspicious:
            sus.append((i, s))

    name = pathlib.Path(path).name
    if tot_removed == 0 and tot_faint == 0 and not sus:
        print(f"  {name:26s} 干净，没动")
        return 0

    print(
        f"  {name:26s} 删掉 {tot_removed} 个绿碎块 / {tot_px} px"
        f" + 扫掉 {tot_faint} px 半透明淡绿（共 {len(frames)} 帧）"
    )
    for i, (n, g, y0, y1, x0, x1) in sus:
        print(f"      ⚠️  帧{i} 有个不偏绿的独立块 {n}px（偏绿{g*100:.0f}%）y{y0}-{y1} x{x0}-{x1} —— 保留了，自己看一眼")

    if DRY:
        print("      DRY=1，没写文件")
        return tot_px + tot_faint

    out_frames[0].save(
        path,
        save_all=True,
        append_images=out_frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
    )
    return tot_px + tot_faint


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip())
        return 1
    targets = []
    for a in args:
        p = pathlib.Path(a)
        if p.is_dir():
            targets.extend(sorted(p.glob("*.apng")))
        elif p.exists():
            targets.append(p)
        else:
            print(f"路径不存在，跳过：{a}")
    if not targets:
        print("没找到 .apng")
        return 1
    print(f"清理脱离主体的绿碎块（alpha>{ALPHA_TH} 算实体，块内偏绿≥{GREEN_RATIO*100:.0f}% 才删）")
    total = 0
    for t in targets:
        total += process(t)
    print(f"共清掉 {total} px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
