# -*- coding: utf-8 -*-
"""斜方投射サンプル動画ジェネレータ（PIL版・numpy不要）

gen_samples.py と同じ見た目・エンコード条件で samples/oblique_throw.mp4 を作る。
numpy / opencv が無い環境向けのフォールバック実装（描画は4倍解像度で
スーパーサンプリングしてから縮小し、cv2のサブピクセル描画と同等の滑らかさを得る）。

真値: v0 = 4.9 m/s, 発射角 45°, g = 9.8 m/s²
      → v0x = v0y = 3.464 m/s, 滞空 0.707 s, 最高点 0.61 m, 水平到達 2.45 m
スケール: 300 px = 1 m（画面内の「1 m」バーで校正）

使い方:  python3 tools/gen_oblique_pil.py
必要:    Pillow, ffmpeg (PATH上)
"""
import math
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont

FPS = 60
SS = 4  # スーパーサンプリング倍率
BG = (15, 18, 22)        # RGB: 暗室グラファイト(#0F1216)
BAR = (225, 230, 235)    # RGB: 明るいオフホワイト
AMBER = (255, 182, 39)   # RGB: 物体1 シグナル・アンバー

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")

G = 9.8  # m/s^2


def _font(size):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_scale_bar(d, x, y, px_per_m, font):
    """「1 m」スケールバー（gen_samples.py と同じ意匠）。座標はSS倍で渡す。"""
    x2 = x + px_per_m
    xm = x + px_per_m // 2
    w = 3 * SS
    d.line([(x, y), (x2, y)], fill=BAR, width=w)
    for xt, half in ((x, 9 * SS), (x2, 9 * SS), (xm, 6 * SS)):
        d.line([(xt, y - half), (xt, y + half)], fill=BAR, width=w)
    label = "1 m"
    bbox = d.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    lx, ly = xm - tw // 2, y - 14 * SS - th
    pad = 6 * SS
    d.rectangle([lx - pad, ly - pad, lx + tw + pad, ly + th + pad], fill=BG)
    d.text((lx, ly), label, font=font, fill=BAR)


def gen_oblique():
    """斜方投射（横）: scale 300px=1m, v0=4.9m/s・45°で打ち上げ、同じ高さに戻るまで"""
    W, H, PPM = 960, 540, 300
    V0, ANGLE = 4.9, math.radians(45.0)
    v0x, v0y = V0 * math.cos(ANGLE), V0 * math.sin(ANGLE)
    duration = 2 * v0y / G  # 0.707 s
    n = int(duration * FPS) + 1
    x0, y0, r = 60.0, 480.0, 12.0

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "oblique_throw.mp4")
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-framerate", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "20",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
        stdin=subprocess.PIPE)

    font = _font(int(0.6 * 24) * SS)  # cv2 の 0.6スケール相当
    for i in range(n):
        t = i / FPS
        img = Image.new("RGB", (W * SS, H * SS), BG)
        d = ImageDraw.Draw(img)
        draw_scale_bar(d, 20 * SS, (H - 30) * SS, PPM * SS, font)
        x = (x0 + v0x * t * PPM) * SS
        y = (y0 - (v0y * t - 0.5 * G * t * t) * PPM) * SS
        rr = r * SS
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=AMBER)
        frame = img.resize((W, H), Image.LANCZOS)
        p.stdin.write(frame.tobytes())
    p.stdin.close()
    p.wait()
    kb = os.path.getsize(path) / 1024
    print(f"  oblique_throw.mp4: {n}f ({n / FPS:.2f}s) {W}x{H} {kb:.0f}KB")
    print(f"    真値: v0={V0} m/s 45°, v0x=v0y={v0x:.3f} m/s, "
          f"滞空 {duration:.3f}s, 最高点 {v0y ** 2 / (2 * G):.3f}m, 水平 {v0x * duration:.3f}m")


if __name__ == "__main__":
    print("samples/oblique_throw.mp4 を生成中 (60fps, H.264/yuv420p):")
    gen_oblique()
