#!/usr/bin/env bash
# 可灵视频 → 桌宠可用的透明动图（APNG）
#
# 用法：
#   scripts/kling-to-frames.sh <输入目录> <输出目录> [选项]
#   scripts/kling-to-frames.sh ~/Downloads/kling src/skins/my-skin/frames
#
# 输入目录里放 8 个 mp4，按状态命名：
#   idle.mp4 running.mp4 awaiting_grant.mp4 awaiting_choice.mp4
#   done.mp4 stale.mp4   exiting.mp4        limp.mp4
#
# 状态之外的额外片段用 EXTRA 指定（运行中的多段动作就走这条）：
#   EXTRA="running_burst running_wipe running_stumble running_glance" \
#     scripts/kling-to-frames.sh ~/Downloads/kling src/skins/yunnuo/frames
#
# 为什么输出 APNG 而不是 GIF 或 WebP：
#   GIF 只有 1 bit alpha，边缘会是锯齿硬边，贴在桌面上很脏。
#   动画 WebP 需要 libwebp 编码器，本机 ffmpeg 没编进去（已实测）。
#   APNG 支持全 alpha 通道，Chromium 的 <img> 直接播，是这台机器上唯一可行且好看的选项。
#
# 本脚本的滤镜链已在本机 ffmpeg 8.1.2 上实测通过：
#   colorkey → despill → rgba → 30 帧 APNG，pix_fmt=rgba 验证有效。

set -euo pipefail

IN=${1:-}
OUT=${2:-}
if [[ -z "$IN" || -z "$OUT" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# 可调参数（环境变量覆盖）
#
# KEY_COLOR 默认**自动从视频首帧四角取样**，不再写死 #00B140。
# 原因：提示词里写的是 #00B140，但视频生成工具吐出来的绿常常不是那个值
# （实测某段是 #069040，差 39）。写死 key 色就得靠加大容差去够，而容差一大
# 就会把角色的深色线条一起抠穿 —— 深棕在 RGB 欧氏空间里离暗绿比直觉近得多：
# RGB(93,69,63) 到 #00B140 的归一距离只有 0.32，而脚本原来的
# similarity=0.30 + blend=0.12 正好覆盖到 0.42，于是眼睛、眉毛被削成半透明，
# 桌面上就是两个透视孔（实测踩过，很难联想到是抠像干的）。
# 取样到真实绿之后，容差可以收得很紧，深色线条就安全了。
KEY_COLOR=${KEY_COLOR:-auto}       # auto = 从首帧四角取样；也可写死如 0x00B140
SIMILARITY=${SIMILARITY:-0.12}     # 抠像容差。绿边残留就调大，但 similarity+blend
                                   # **必须小于 0.25**，否则会抠穿深色线条
BLEND=${BLEND:-0.08}               # 边缘羽化
# despill 默认**关**。它是全局去绿的,角色身上本来就有绿色时会被一起洗掉:
# 云糯的薄荷绿耳朵和头毛开了 despill 会变成灰蓝(实测 (202,227,210) → (210,214,219),
# 84px 下一眼就看出不对)。而不开 despill 留下的绿边只在半透明的亚像素边缘上,
# 同样 84px 下根本看不见。宁可留看不见的绿边,不要肉眼可辨的错色。
# 角色身上完全没有绿色的皮肤可以 DESPILL=1 开回来。
# 注意 despill 的 mix 参数调小没用,实测 mix=0.15 照样把耳朵洗成灰的。
DESPILL=${DESPILL:-0}
FPS=${FPS:-12}                     # 12 帧足够，帧数直接决定文件大小
DURATION=${DURATION:-2.5}          # 取多长；主力循环靠首尾帧一致做无缝
# 从第几秒开始取。主力循环用 0（从头截一个完整步态周期就行），
# 但**事件段必须用它**：冲刺/抹汗/踉跄/回头这些动作发生在片子中段，
# 从 0 截只会得到事件发生前的稳定跑动，把事件整段丢掉（实测踩过）。
# check-clip.py 会直接告诉你某段该填多少。
START=${START:-0}
SIZE=${SIZE:-512}                  # 输出边长

STATES=(idle running awaiting_grant awaiting_choice done stale exiting limp)

# 额外片段(状态之外的动作帧),空格分隔。例如运行中的多段:
#   EXTRA="running_burst running_wipe running_stumble running_glance" scripts/kling-to-frames.sh ...
# 为什么要这个:运行中状态动辄持续几分钟,单一个循环重复几百遍很假,
# 所以主力循环之外再出几段偶发动作,由渲染层随机插播(见 pet.js 的 startRunningSegments)。
# 这些名字不是状态,缺了不会有任何告警 —— 渲染层按"skin.assets 里有没有"来决定插不插。
EXTRA=${EXTRA:-}
CLIPS=("${STATES[@]}")
if [[ -n "$EXTRA" ]]; then
  read -ra _extra <<<"$EXTRA"
  CLIPS+=("${_extra[@]}")
fi

DESPILL_F=""
[[ "$DESPILL" == "1" ]] && DESPILL_F=",despill"
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg：brew install ffmpeg"; exit 1; }
mkdir -p "$OUT"

# 从某个视频的首帧四角取样真实绿幕色
sample_key() {
  local src=$1 tmp
  tmp=$(mktemp -t aicpkey).png
  ffmpeg -hide_banner -loglevel error -y -i "$src" -frames:v 1 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  python3 - "$tmp" <<'PY'
import sys
from collections import Counter
try:
    from PIL import Image
except ImportError:
    print(""); raise SystemExit
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
n = max(8, min(w, h) // 24)
px = []
for bx, by in ((0, 0), (w - n, 0), (0, h - n), (w - n, h - n)):
    px += list(im.crop((bx, by, bx + n, by + n)).getdata())
r, g, b = Counter(px).most_common(1)[0][0]
print("0x%02X%02X%02X" % (r, g, b))
PY
  rm -f "$tmp"
}

echo "容差=$SIMILARITY 羽化=$BLEND 帧率=$FPS 时长=${DURATION}s 尺寸=${SIZE}px despill=$DESPILL"
if [[ "$KEY_COLOR" == "auto" ]]; then
  echo "抠像色=auto（每个视频各自从首帧四角取样）"
else
  echo "抠像色=$KEY_COLOR（手动指定）"
fi
echo

missing=0
MADE=()   # 本次真正产出的 apng，收尾清理只动这些
for st in "${CLIPS[@]}"; do
  src=""
  for ext in mp4 mov webm; do
    [[ -f "$IN/$st.$ext" ]] && src="$IN/$st.$ext" && break
  done

  if [[ -z "$src" ]]; then
    # 只有八个状态缺了才算问题;额外片段缺失是常态(你可能只出了其中两段)
    if [[ " ${STATES[*]} " == *" $st "* ]]; then
      echo "  跳过 $st —— 输入目录里没有 $st.mp4"
      missing=$((missing + 1))
    fi
    continue
  fi

  dst="$OUT/$st.apng"

  key=$KEY_COLOR
  if [[ "$key" == "auto" ]]; then
    key=$(sample_key "$src" || true)
    [[ -z "$key" ]] && key=0x00B140   # 取样失败就退回提示词里写的那个
  fi

  # despill 去掉主体边缘吃到的绿色反光，不加会有一圈绿边
  # -ss 放在 -i 前面是输入级 seek（快且准），-t 之后按 START 起点算
  ffmpeg -hide_banner -loglevel error -y \
    -ss "$START" -t "$DURATION" -i "$src" \
    -vf "fps=$FPS,colorkey=$key:$SIMILARITY:$BLEND${DESPILL_F},format=rgba,scale=$SIZE:$SIZE:force_original_aspect_ratio=decrease:flags=lanczos,pad=$SIZE:$SIZE:(ow-iw)/2:oh-ih:color=0x00000000" \
    -plays 0 -f apng "$dst"

  frames=$(ffprobe -hide_banner -loglevel error -select_streams v:0 -count_frames \
    -show_entries stream=nb_read_frames -of csv=p=0 "$dst" 2>/dev/null || echo '?')
  kb=$(( $(stat -f%z "$dst" 2>/dev/null || stat -c%s "$dst") / 1024 ))
  printf '  ok  %-16s %s 帧, %s KB  key=%s\n' "$st" "$frames" "$kb" "$key"
  MADE+=("$dst")
done

# 收尾：删掉「脱离主体的绿碎块」和绿溢色。
# AIGC 会自己加运动弧线/尘土/地面线，它们的绿和绿幕不是同一个绿，抠像抠不掉，
# 但一定和角色不相连 —— 所以按连通性+颜色删，比调抠像参数安全得多。
#
# ⚠️ **只清本次新产出的文件，不要清整个目录。**
# 去绿溢色那一刀是从「当前 alpha 边缘」往里量的，反复跑会一层层往里啃：
# 实测把 7 个状态挨个跑一遍（每次都清全目录）后，exiting 被清了 5 遍，
# 薄荷绿头毛里被挖出 556px 的洞，而只清一遍时是 0。
if command -v python3 >/dev/null && [[ -f "$(dirname "$0")/clean-apng.py" ]] && (( ${#MADE[@]} )); then
  echo
  python3 "$(dirname "$0")/clean-apng.py" "${MADE[@]}" || echo "  （清理步骤失败，不影响已产出的 apng）"
fi

echo
if (( missing > 0 )); then
  echo "有 $missing 个状态缺输入。桌宠会为缺失状态打告警并降级，不会崩。"
fi

cat <<'TIP'
接下来：
  1. scripts/adopt-anim.py <皮肤目录>   把 .apng 接进 skin.json
     （改扩展名 + 删该状态的 loop。loop 不删会和图里的动作打架，
       而且不报错、只是"抖得有点怪"，最容易漏，所以做成脚本）
  2. AICP_SKIN=<皮肤名> npm run poses  看八态是否对齐同一条基准线
  3. 角色上下跳说明各状态里主体大小/位置不一致，
     用 skin.json 里该状态的 pose.figure.y 微调补偿
TIP
