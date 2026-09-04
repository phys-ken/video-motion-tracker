# -*- coding: utf-8 -*-
"""物理サンプル動画ジェネレータ（samples/*.mp4 を再生成する）

真値が既知の合成動画を作る。生徒が校正〜トラッキング〜グラフまで練習できるよう、
各動画に「1 m」のスケールバーを描く（方眼は描かない＝目分量で答えが見えないように）。
エンコードは Safari/iPad 互換の H.264 / yuv420p / faststart / 60fps CFR。

使い方:  python tools/gen_samples.py
必要:    numpy, opencv-python(-headless), ffmpeg (PATH上)
         例) uv venv .venv && uv pip install --python .venv/bin/python numpy opencv-python-headless

真値の一覧は MANUAL.md「サンプル動画の真値」を参照（このファイルが一次情報源）。
"""
import math
import subprocess
import numpy as np
import cv2
import os

FPS = 60
SHIFT = 4          # cv2のサブピクセル描画（微小移動でも画素が滑らかに変わる）
BAR = (235, 230, 225)      # BGR: 明るいオフホワイト（校正バーは目立たせる）
INK = (51, 41, 31)         # BGR: 濃紺グレー(#1F2933) — バーの縁取り・ラベル地
AMBER = (39, 182, 255)     # BGR: 物体1 シグナル・アンバー(#FFB627)
CYAN = (230, 169, 90)      # BGR: 物体2 シアン(#5AA9E6)

# 教室の背景色（BGR）。実際の教室の色味で見え方を確かめられるようにしつつ、
# 彩度と明度を落として、追跡する球と打点が背景に埋もれないようにしている。
WALL = (198, 206, 213)     # 明るいベージュの壁
WALL_LO = (176, 185, 194)  # 腰壁（下half）
FLOOR = (125, 138, 160)    # 木の床（明るいがRGBのB値を残し、球の色検出と衝突しないようにする）
BOARD = (74, 86, 62)       # 黒板の深緑
WOOD = (94, 122, 152)      # 黒板・窓の木枠
SKY = (214, 198, 172)      # 窓の外
DESK = (126, 150, 178)     # 机

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")

_BG_CACHE = {}


def classroom_bg(w, h):
    """教室風の背景を描く（黒板・窓・床・机）。写真は使わず全部コード描画なので、
    素材のライセンスを気にせずリポジトリに置ける。同じ寸法なら使い回す。"""
    key = (w, h)
    if key in _BG_CACHE:
        return _BG_CACHE[key]
    f = np.zeros((h, w, 3), np.uint8)
    horizon = int(h * 0.74)
    f[:horizon, :] = WALL
    f[int(horizon * 0.72):horizon, :] = WALL_LO      # 腰壁
    cv2.line(f, (0, int(horizon * 0.72)), (w, int(horizon * 0.72)), WOOD, 2, cv2.LINE_AA)
    f[horizon:, :] = FLOOR
    for i in range(1, 7):                             # 床板の目地（奥ほど詰まって見える）
        y = horizon + int((h - horizon) * (i / 6.0) ** 1.6)
        cv2.line(f, (0, y), (w, y), (104, 122, 144), 1, cv2.LINE_AA)
    cv2.rectangle(f, (0, horizon - 10), (w, horizon), (86, 110, 138), -1)   # 巾木

    # 黒板（左寄せ）: 枠 → 盤面 → チョークの拭き跡 → チョーク受け
    bx1, by1 = int(w * 0.05), int(h * 0.09)
    bx2, by2 = int(w * 0.63), int(h * 0.42)
    cv2.rectangle(f, (bx1 - 7, by1 - 7), (bx2 + 7, by2 + 7), WOOD, -1)
    cv2.rectangle(f, (bx1, by1), (bx2, by2), BOARD, -1)
    rng = np.random.default_rng(7)                    # 毎回同じ絵になるよう種を固定
    for _ in range(18):
        x0 = int(rng.uniform(bx1 + 10, bx2 - 60)); y0 = int(rng.uniform(by1 + 10, by2 - 10))
        cv2.line(f, (x0, y0), (x0 + int(rng.uniform(30, 90)), y0 + int(rng.uniform(-4, 4))),
                 (96, 108, 84), int(rng.integers(2, 6)), cv2.LINE_AA)
    cv2.rectangle(f, (bx1 - 7, by2 + 7), (bx2 + 7, by2 + 16), WOOD, -1)

    # 窓（右寄せ）: 空 → 光の帯 → 桟
    wx1, wy1 = int(w * 0.70), int(h * 0.11)
    wx2, wy2 = int(w * 0.96), int(h * 0.40)
    cv2.rectangle(f, (wx1 - 6, wy1 - 6), (wx2 + 6, wy2 + 6), (232, 232, 232), -1)
    cv2.rectangle(f, (wx1, wy1), (wx2, wy2), SKY, -1)
    cv2.rectangle(f, (wx1, wy1), (wx2, wy1 + int((wy2 - wy1) * 0.25)), (228, 216, 196), -1)
    cv2.line(f, ((wx1 + wx2) // 2, wy1), ((wx1 + wx2) // 2, wy2), (232, 232, 232), 5, cv2.LINE_AA)
    cv2.line(f, (wx1, (wy1 + wy2) // 2), (wx2, (wy1 + wy2) // 2), (232, 232, 232), 5, cv2.LINE_AA)

    # 机（手前・下端に少しだけ）: 天板を台形にして奥行きを出す
    dw = int(w * 0.30)
    for k, cx in enumerate((int(w * 0.20), int(w * 0.62), int(w * 1.02))):
        top = h - int((h - horizon) * 0.42)
        pts = np.array([[cx - dw // 2, top], [cx + dw // 2, top],
                        [cx + dw // 2 - 14, top + 14], [cx - dw // 2 + 14, top + 14]], np.int32)
        cv2.fillPoly(f, [pts], DESK, cv2.LINE_AA)
        cv2.rectangle(f, (cx - dw // 2 + 22, top + 14), (cx - dw // 2 + 30, h), (96, 118, 142), -1)
        cv2.rectangle(f, (cx + dw // 2 - 30, top + 14), (cx + dw // 2 - 22, h), (96, 118, 142), -1)

    _BG_CACHE[key] = f
    return f


CLOCK = (238, 240, 242)    # 掛け時計の文字盤
HAND = (58, 52, 46)        # 時計の針
CLOUD = (238, 232, 222)    # 窓の外の雲


def draw_motion_props(f, i):
    """毎コマ必ず絵が変わるように、教室の「動くもの」を描く。

    これが無いと、静止している前後のコマがエンコーダの複製フレームと見分けが
    つかず、アプリの複製除外（changedFraction < 0.08%）に落とされてしまう。
    掛け時計の秒針と窓の外の雲を、しきい値に対して十分な余裕をもって動かす。
    針も雲も球からは離れた位置に描くので、追跡の真値には影響しない。
    """
    h, w = f.shape[:2]
    s = 1 << SHIFT

    # 掛け時計（黒板の右上・壁の高いところ）。秒針は1秒で1周させる。
    # 実物より速いが、静止コマを「同じ絵」にしないための仕掛けなので割り切る。
    cx, cy = int(w * 0.80), int(h * 0.055)
    r = max(18, int(w * 0.062))
    cv2.circle(f, (cx * s, cy * s), (r + 3) * s, HAND, -1, cv2.LINE_AA, SHIFT)
    cv2.circle(f, (cx * s, cy * s), r * s, CLOCK, -1, cv2.LINE_AA, SHIFT)
    for k in range(12):                                   # 文字盤の目盛り
        a = math.pi * 2 * k / 12
        p1 = (cx + math.cos(a) * r * 0.78, cy + math.sin(a) * r * 0.78)
        p2 = (cx + math.cos(a) * r * 0.92, cy + math.sin(a) * r * 0.92)
        cv2.line(f, (int(p1[0] * s), int(p1[1] * s)), (int(p2[0] * s), int(p2[1] * s)),
                 HAND, 2 * s // 2, cv2.LINE_AA, SHIFT)
    for ang, ln, th in ((-math.pi / 3, 0.50, 5), (math.pi / 5, 0.72, 4)):   # 短針・長針（固定）
        cv2.line(f, (cx * s, cy * s),
                 (int((cx + math.cos(ang) * r * ln) * s), int((cy + math.sin(ang) * r * ln) * s)),
                 HAND, th, cv2.LINE_AA, SHIFT)
    a = -math.pi / 2 + math.pi * 2 * (i % FPS) / FPS      # 秒針: 1周 = 60コマ
    cv2.line(f, (cx * s, cy * s),
             (int((cx + math.cos(a) * r * 0.88) * s), int((cy + math.sin(a) * r * 0.88) * s)),
             (60, 60, 200), 3, cv2.LINE_AA, SHIFT)
    cv2.circle(f, (cx * s, cy * s), 3 * s, HAND, -1, cv2.LINE_AA, SHIFT)

    # 窓の外を流れる雲。アプリの複製除外は 160x90 に縮小して判定するので、
    # 縦方向は約1/11に潰れる。ゆっくりの雲では「絵が変わっていない」と見なされて
    # 静止コマが落とされるため、常に雲が窓の中にいるよう3つ並べ、しっかり流す。
    wx1, wy1 = int(w * 0.70), int(h * 0.11)
    wx2, wy2 = int(w * 0.96), int(h * 0.40)
    ww, wh = wx2 - wx1, wy2 - wy1
    sub = f[wy1:wy2, wx1:wx2].copy()
    span = ww + 220
    for k, (fy, rr, spd) in enumerate(((0.28, 0.30, 6.5), (0.58, 0.24, 5.0), (0.80, 0.20, 7.5))):
        cxx = -110 + ((i * spd + k * span / 3.0) % span)
        cyy = wh * fy
        rad = wh * rr
        for dx, dy, m in ((-0.95, 0.16, 0.72), (0.0, 0.0, 1.0), (0.9, 0.2, 0.66)):
            cv2.circle(sub, (int((cxx + dx * rad) * s), int((cyy + dy * rad) * s)),
                       int(rad * m * s), CLOUD, -1, cv2.LINE_AA, SHIFT)
    f[wy1:wy2, wx1:wx2] = sub


def new_frame(w, h, i=None):
    f = classroom_bg(w, h).copy()
    if i is not None:
        draw_motion_props(f, i)
    return f


def draw_scale_bar(f, x, y, px_per_m):
    """「1 m」のスケールバー。背景が明るくても暗くても消えないよう、
    濃い縁取りの上に明るい線を重ねる。"""
    x2 = x + px_per_m
    xm = x + px_per_m // 2
    for color, extra in ((INK, 3), (BAR, 0)):        # 縁取り → 本体
        cv2.line(f, (x, y), (x2, y), color, 3 + extra, cv2.LINE_AA)
        for xt, half in ((x, 9), (x2, 9), (xm, 6)):  # 両端は長め、中央(50cm)は短めのティック
            cv2.line(f, (xt, y - half), (xt, y + half), color, 3 + extra, cv2.LINE_AA)
    label = "1 m"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
    lx, ly = xm - tw // 2, y - 14
    cv2.rectangle(f, (lx - 6, ly - th - 5), (lx + tw + 6, ly + 5), INK, -1)
    cv2.putText(f, label, (lx, ly), cv2.FONT_HERSHEY_SIMPLEX, 0.6, BAR, 2, cv2.LINE_AA)


def ball(f, x, y, r, color):
    """追跡する球。背景が黒板（暗）でも壁（明）でも輪郭が消えないよう、
    細い暗色のフチを付ける（フチは左右対称なので重心＝真値はずれない）。"""
    s = 1 << SHIFT
    c = (int(round(x * s)), int(round(y * s)))
    cv2.circle(f, c, int((r + 1.5) * s), INK, -1, cv2.LINE_AA, SHIFT)
    cv2.circle(f, c, int(r * s), color, -1, cv2.LINE_AA, SHIFT)


def encode(name, frames, w, h):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-framerate", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "20",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
        stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    kb = os.path.getsize(path) / 1024
    print(f"  {name}: {len(frames)}f ({len(frames)/FPS:.2f}s) {w}x{h} {kb:.0f}KB")


G = 9.8  # m/s^2


# 自由落下サンプルだけは、授業でトリミング操作も体験できるよう、
# 運動の前後に「何も起きていない区間」を付けてある（真値は落下の35コマのまま）。
FF_LEAD = 24    # 落とす前（手で持って静止）
FF_TAIL = 21    # 落ちきった後（床で静止）


def gen_free_fall():
    """自由落下（縦・v0=0）: scale 500px=1m, y0から1.6m落下。
    前に24コマ・後ろに21コマの静止区間を付ける（トリミングの練習用）。"""
    W, H, PPM = 540, 960, 500
    n = 35  # 0.567s → 落下 1.57m
    Y0 = 80.0
    y_end = Y0 + 0.5 * G * ((n - 1) / FPS) ** 2 * PPM
    frames = []
    for k in range(FF_LEAD + n + FF_TAIL):
        f = new_frame(W, H, k)                      # 時計と雲は全コマ動き続ける
        draw_scale_bar(f, 20, H - 30, PPM)
        if k < FF_LEAD:                             # 手で持って静止
            y = Y0
        elif k < FF_LEAD + n:                       # 落下（ここが真値の区間）
            t = (k - FF_LEAD) / FPS
            y = Y0 + 0.5 * G * t * t * PPM
        else:                                       # 落ちきって静止
            y = y_end
        ball(f, W / 2, y, 14, AMBER)
        frames.append(f)
    encode("free_fall.mp4", frames, W, H)


def gen_vertical_throw():
    """鉛直投げ上げ（縦）: v0=4.4m/s ↑、上がって戻るまで"""
    W, H, PPM = 540, 960, 500
    V0 = 4.4
    n = int(2 * V0 / G * FPS) + 1  # 0.898s
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        y = 880 - (V0 * t - 0.5 * G * t * t) * PPM
        ball(f, W / 2, y, 14, AMBER)
        frames.append(f)
    encode("vertical_throw.mp4", frames, W, H)


def gen_projectile():
    """水平投射（横）: scale 300px=1m, v0x=5.0m/s・v0y=0"""
    W, H, PPM = 960, 540, 300
    V0X = 5.0
    n = 34  # 0.55s → 落下1.48m・水平2.75m
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        x = 40 + V0X * t * PPM
        y = 40 + 0.5 * G * t * t * PPM
        ball(f, x, y, 12, AMBER)
        frames.append(f)
    encode("projectile.mp4", frames, W, H)


def gen_oblique():
    """斜方投射（横）: scale 300px=1m, v0=4.9m/s・45°、同じ高さに戻るまで"""
    W, H, PPM = 960, 540, 300
    V0, ANGLE = 4.9, math.radians(45.0)
    v0x, v0y = V0 * math.cos(ANGLE), V0 * math.sin(ANGLE)
    n = int(2 * v0y / G * FPS) + 1  # 0.707s
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H)
        draw_scale_bar(f, 20, H - 30, PPM)
        x = 60 + v0x * t * PPM
        y = 480 - (v0y * t - 0.5 * G * t * t) * PPM
        ball(f, x, y, 12, AMBER)
        frames.append(f)
    encode("oblique_throw.mp4", frames, W, H)


def main():
    print("samples/ を生成中 (60fps, H.264/yuv420p):")
    gen_free_fall()
    gen_vertical_throw()
    gen_projectile()
    gen_oblique()
    print("完了。真値の一覧は MANUAL.md を参照。")


if __name__ == "__main__":
    main()
