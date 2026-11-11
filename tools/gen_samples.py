# -*- coding: utf-8 -*-
"""物理サンプル動画ジェネレータ（samples/*.mp4 を再生成する）

真値が既知の合成動画を作る。生徒が校正〜トラッキング〜グラフまで練習できるよう、
各動画に、縦に立てた「1 m」のものさしを描く（実験でよくある置き方。方眼は描かない）。
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


LED = (70, 70, 245)        # ストップウォッチの数字（赤いLED。球のアンバーとは色で分かれる）
LED_OFF = (42, 40, 48)     # 消えている区画（ごくうっすら見える）
PANEL = (34, 32, 30)       # ストップウォッチの盤面

# 7セグメントの各区画（a〜g）。数字ごとに点く区画。
_SEG_ON = {0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg",
           5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg"}


def _seven_seg(f, x, y, dw, dh, th, digit):
    """左上(x, y)・幅dw・高さdhの7セグ数字を1桁描く。"""
    hh = dh // 2
    g = th // 2 + 2                                    # 区画どうしのすき間（LEDらしく離す）
    segs = {"a": ((x + g, y), (x + dw - g, y)), "g": ((x + g, y + hh), (x + dw - g, y + hh)),
            "d": ((x + g, y + dh), (x + dw - g, y + dh)),
            "f": ((x, y + g), (x, y + hh - g)), "b": ((x + dw, y + g), (x + dw, y + hh - g)),
            "e": ((x, y + hh + g), (x, y + dh - g)), "c": ((x + dw, y + hh + g), (x + dw, y + dh - g))}
    on = _SEG_ON[digit]
    for k, (p1, p2) in segs.items():
        cv2.line(f, p1, p2, LED if k in on else LED_OFF, th, cv2.LINE_AA)


def draw_stopwatch(f, x, y, sec):
    """壁掛けのデジタルタイマー（「秒.1/1000秒」の5桁。光電門タイマーと同じ表示）。

    映像の中で時間が流れていることが一目で分かる。60fps では 1/100 秒と
    1/1000 秒の桁が毎コマ必ず変わるので、球が止まっているコマも「同じ絵」に
    ならず、アプリの複製除外（changedFraction < 0.08%）に落とされない。
    """
    dw, dh, th, gap = 24, 64, 6, 13   # 判定は縦が1/11に潰れるので、数字は縦長に大きく
    ms = int(round(sec * 1000)) % 100000
    digits = [ms // 10000, ms // 1000 % 10, ms // 100 % 10, ms // 10 % 10, ms % 10]
    pw = 5 * dw + 4 * gap + 28 + 16
    cv2.rectangle(f, (x - 4, y - 4), (x + pw + 4, y + dh + 40), (90, 92, 96), -1, cv2.LINE_AA)
    cv2.rectangle(f, (x, y), (x + pw, y + dh + 36), PANEL, -1)
    cx = x + 18
    for k, d in enumerate(digits):
        _seven_seg(f, cx, y + 18, dw, dh, th, d)
        cx += dw + gap
        if k == 1:                                         # 小数点
            cv2.circle(f, (cx - gap // 2 + 2, y + 18 + dh), 4, LED, -1, cv2.LINE_AA)
            cx += 12


def draw_motion_props(f, i):
    """教室の「動くもの」（掛け時計の秒針・窓の外の雲）を描く。

    どちらも実物らしい速さにしてある（秒針は1秒ごとに1目盛り、雲はゆっくり）。
    静止したコマを複製と誤判定させない役目は、自由落下サンプルの
    ストップウォッチ（draw_stopwatch）が担う。
    針も雲も球からは離れた位置に描くので、追跡の真値には影響しない。
    """
    h, w = f.shape[:2]
    s = 1 << SHIFT

    # 掛け時計（黒板の右上・壁の高いところ）。秒針は1秒ごとにカチッと1目盛り進む。
    r = max(18, int(min(w, h) * 0.062))                   # 横動画でも上端で切れない大きさ
    cx, cy = int(w * 0.80), max(int(h * 0.055), r + 8)
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
    sec = 17 + (i + 20) // FPS                            # 秒針: 1秒ごとに1目盛り（6°）
    a = -math.pi / 2 + math.pi * 2 * sec / 60
    cv2.line(f, (cx * s, cy * s),
             (int((cx + math.cos(a) * r * 0.88) * s), int((cy + math.sin(a) * r * 0.88) * s)),
             (60, 60, 200), 3, cv2.LINE_AA, SHIFT)
    cv2.circle(f, (cx * s, cy * s), 3 * s, HAND, -1, cv2.LINE_AA, SHIFT)

    # 窓の外をゆっくり流れる雲（1コマに 0.3〜0.5 px）。
    wx1, wy1 = int(w * 0.70), int(h * 0.11)
    wx2, wy2 = int(w * 0.96), int(h * 0.40)
    ww, wh = wx2 - wx1, wy2 - wy1
    sub = f[wy1:wy2, wx1:wx2].copy()
    span = ww + 220
    for k, (fy, rr, spd) in enumerate(((0.28, 0.30, 0.4), (0.58, 0.24, 0.3), (0.80, 0.20, 0.5))):
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


RULER = (150, 205, 232)    # BGR: 1 m ものさしの木の色（青を残し、球のアンバー検出と重ならない）


def draw_ruler(f, x, y_bottom, px_per_m):
    """床に縦に立てた 1 m ものさし。下端（0）が y_bottom、上端（100）が y_bottom - px_per_m。

    実験では、ものさしを落下の向き（縦）に立てて一緒に写すことが多いので、それに合わせる。
    目盛りは 1 cm ごと（細かすぎる縮尺では 5 cm ごと）、10 cm ごとに数字。
    校正は両端（0 と 100）をタップすれば 1 m になる。
    """
    top = y_bottom - px_per_m
    wd = 30 if px_per_m >= 400 else 24
    cv2.rectangle(f, (x, top), (x + wd, y_bottom), RULER, -1)
    cv2.rectangle(f, (x, top), (x + wd, y_bottom), INK, 1)
    step_cm = 1 if px_per_m / 100 >= 4 else 5
    for cm in range(0, 101, step_cm):
        y = int(round(y_bottom - px_per_m * cm / 100))
        ln = wd * 0.55 if cm % 10 == 0 else (wd * 0.35 if cm % 5 == 0 else wd * 0.2)
        cv2.line(f, (x, y), (x + int(ln), y), INK, 1, cv2.LINE_AA)
    for cm in range(10, 100, 10):                     # 数字（10〜90）。目盛りの右の空きに置く
        y = int(round(y_bottom - px_per_m * cm / 100))
        cv2.putText(f, str(cm), (x + int(wd * 0.5), y + 4), cv2.FONT_HERSHEY_PLAIN,
                    0.75 if wd >= 30 else 0.6, INK, 1, cv2.LINE_AA)
    # 両端をはっきりさせる（ここをタップして校正する）
    for y in (top, y_bottom):
        cv2.line(f, (x - 3, y), (x + wd + 3, y), INK, 2, cv2.LINE_AA)
    # 「1 m」の札（ものさしの右、上寄り）
    label = "1 m"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
    lx, ly = x + wd + 10, top + px_per_m // 4
    if lx + tw + 8 > f.shape[1]:                      # 右に入らなければ左に置く
        lx = x - 10 - tw
    cv2.rectangle(f, (lx - 6, ly - th - 5), (lx + tw + 6, ly + 5), INK, -1)
    cv2.putText(f, label, (lx, ly), cv2.FONT_HERSHEY_SIMPLEX, 0.6, BAR, 2, cv2.LINE_AA)


def ball(f, x, y, r, color):
    """追跡する球。背景が黒板（暗）でも壁（明）でも輪郭が消えないよう、
    細い暗色のフチを付ける（フチは左右対称なので重心＝真値はずれない）。"""
    s = 1 << SHIFT
    c = (int(round(x * s)), int(round(y * s)))
    cv2.circle(f, c, int((r + 1.5) * s), INK, -1, cv2.LINE_AA, SHIFT)
    cv2.circle(f, c, int(r * s), color, -1, cv2.LINE_AA, SHIFT)


SKIN = (160, 192, 234)     # BGR: 手（青を多めに残し、球のアンバー検出に入らない）
SKIN_EDGE = (110, 138, 178)
SLEEVE = (112, 92, 70)     # BGR: 制服の袖（紺）


def draw_hand(f, bx, by, open_amt, lift):
    """上から球をつまんで持つ手。open_amt=0 で握り、1 で指が開ききる。
    lift は放したあとに手が上へ引く量（px）。

    手のひらは球の上端より上に描くので、指が開けば球には一切かからない
    （落下中のコマで球の見え方＝真値に影響しない）。
    """
    s = 1 << SHIFT
    py = by - 38 - lift                                   # 手のひらの中心
    # 袖と腕: 画面の上端から手のひらへ（右上から斜めに入る）
    arm = np.array([[bx + 4, py - 6], [bx + 30, py - 14],
                    [bx + 92, -10], [bx + 50, -10]], np.int32)
    cv2.fillPoly(f, [arm], SKIN, cv2.LINE_AA)
    cuff = np.array([[bx + 40, py - 52], [bx + 70, py - 60],
                     [bx + 100, -10], [bx + 60, -10]], np.int32)
    cv2.fillPoly(f, [cuff], SLEEVE, cv2.LINE_AA)
    # 指（親指と人さし指・中指）。付け根を中心に外へ開く
    ang = math.radians(58) * open_amt
    for side, base_dx, ln in ((-1, -15, 34), (1, 15, 36), (1, 7, 32)):
        bxx, byy = bx + base_dx, py + 8
        a = side * ang
        tip = (bxx + side * 4 + math.sin(a) * ln, byy + math.cos(a) * ln)
        for col, th in ((SKIN_EDGE, 12), (SKIN, 9)):
            cv2.line(f, (int(bxx * s), int(byy * s)), (int(tip[0] * s), int(tip[1] * s)),
                     col, th, cv2.LINE_AA, SHIFT)
    cv2.ellipse(f, (int(bx * s), int(py * s)), (25 * s, 17 * s), 0, 0, 360,
                SKIN_EDGE, -1, cv2.LINE_AA, SHIFT)
    cv2.ellipse(f, (int(bx * s), int(py * s)), (23 * s, 15 * s), 0, 0, 360,
                SKIN, -1, cv2.LINE_AA, SHIFT)


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


# 自由落下サンプルは、実際の撮影と同じく「手で持つ → 放す → 落ちる → 床ではねる」
# までを写してある。生徒は授業で、落下だけを残すトリミングを体験する。
# 真値の区間は、手を放したコマ（FF_LEAD）から床に着く直前までの FF_FALL コマ。
FF_LEAD = 45     # 手で持って止まっている（0.75 s）。最後の4コマで指が開く
FF_OPEN = 4      # 指が開くのにかかるコマ数（この間も球は手の中で止まっている）
FF_Y0 = 120.0    # 放す位置（球の中心）
FF_FLOOR = 904.0 # 床に着いたときの球の中心（球の下端 = 918 = ものさしの下端）
FF_E = 0.45      # 床ではね返るときの反発係数
FF_TAIL_REST = 30  # はね終わって床で止まっている（0.5 s）
PPM_TALL = 500   # 縦動画: 500 px = 1 m


def _bounce_y(t, y0, floor, ppm):
    """手を放してから t 秒後の球の中心（落下 → 反発係数 FF_E ではねる → 止まる）。"""
    t_hit = math.sqrt(2 * (floor - y0) / ppm / G)
    if t < t_hit:
        return y0 + 0.5 * G * t * t * ppm, False
    v = G * t_hit * FF_E                               # はね返った直後の上向きの速さ
    tt = t - t_hit
    while v > 0.3:
        dur = 2 * v / G
        if tt < dur:
            return floor - (v * tt - 0.5 * G * tt * tt) * ppm, True
        tt -= dur
        v *= FF_E
    return floor, True


def free_fall_frames():
    """自由落下の真値の区間を返す: (放したコマ, 床に着く直前のコマ, 総コマ数)。
    テストとマニュアル生成もこの値を使う（tools/gen_samples.py が一次情報源）。"""
    t_hit = math.sqrt(2 * (FF_FLOOR - FF_Y0) / PPM_TALL / G)
    n_fall = int(math.floor(t_hit * FPS - 1e-9)) + 1   # t = 0, 1/60, … < t_hit
    t_rest = t_hit
    v = G * t_hit * FF_E
    while v > 0.3:
        t_rest += 2 * v / G
        v *= FF_E
    total = FF_LEAD + int(math.ceil(t_rest * FPS)) + FF_TAIL_REST
    return FF_LEAD, FF_LEAD + n_fall - 1, total


def gen_free_fall():
    """自由落下（縦・v0=0）: 500px=1m。手で持って止まっている → 指が開いて放す →
    1.57 m 落ちて床ではねる → 止まる。ものさしは床に縦に立ててある。"""
    W, H, PPM = 540, 960, PPM_TALL
    BX = W / 2
    first, last, total = free_fall_frames()
    frames = []
    for k in range(total):
        f = new_frame(W, H, k)
        draw_ruler(f, 380, int(FF_FLOOR + 14), PPM)
        draw_stopwatch(f, 26, 560, 8.4 + k / FPS)
        if k < FF_LEAD:                               # 手の中で止まっている
            y = FF_Y0
            open_amt = max(0.0, (k - (FF_LEAD - FF_OPEN) + 1) / FF_OPEN)
            lift = 0.0
        else:                                         # 放した後（k = FF_LEAD が t = 0）
            y, _ = _bounce_y((k - FF_LEAD) / FPS, FF_Y0, FF_FLOOR, PPM)
            open_amt = 1.0
            u = min(1.0, (k - FF_LEAD) / 14)          # 手は少し上へ引く
            lift = 16 * (1 - (1 - u) ** 2)
        ball(f, BX, y, 14, AMBER)
        draw_hand(f, BX, FF_Y0, open_amt, lift)
        frames.append(f)
    encode("free_fall.mp4", frames, W, H)
    print(f"    真値の区間: コマ {first}〜{last}（{last - first + 1}コマ、0始まり）")


def gen_vertical_throw():
    """鉛直投げ上げ（縦）: v0=4.4m/s ↑、上がって戻るまで"""
    W, H, PPM = 540, 960, 500
    V0 = 4.4
    n = int(2 * V0 / G * FPS) + 1  # 0.898s
    frames = []
    for i in range(n):
        t = i / FPS
        f = new_frame(W, H, i)
        draw_ruler(f, 380, 918, PPM)
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
        f = new_frame(W, H, i)
        draw_ruler(f, 915, 520, PPM)                  # 着地点（x≈877）より右に立てる
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
        f = new_frame(W, H, i)
        draw_ruler(f, 880, 506, PPM)
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
