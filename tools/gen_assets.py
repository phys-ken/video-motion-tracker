# -*- coding: utf-8 -*-
"""配布用アセット（QRコード・ファビコン）のジェネレータ

生成物はリポジトリにコミットするので、実行は URL やデザインを変えたときだけでよい。

  uv venv .venv && uv pip install --python .venv/bin/python segno pillow
  .venv/bin/python tools/gen_assets.py

生成先:
  docs/qr/*.png ... 各ページのQRコード（READMEに掲載。授業での配布用）
  assets/favicon.svg / icon-180.png / icon-512.png ... アプリのアイコン
"""
import os

import segno
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
QR_DIR = os.path.join(ROOT, "docs", "qr")
ASSET_DIR = os.path.join(ROOT, "assets")

BASE = "https://phys-ken.github.io/video-motion-tracker/"

# QRにするページ（ファイル名, URL, 用途）
PAGES = [
    ("app", BASE, "アプリ本体"),
    ("guide-free-fall", BASE + "guide/", "手順書: 自由落下"),
    ("guide-vertical-throw", BASE + "guide/vertical_throw.html", "手順書: 鉛直投げ上げ"),
    ("guide-projectile", BASE + "guide/projectile.html", "手順書: 水平投射"),
    ("guide-oblique", BASE + "guide/oblique.html", "手順書: 斜方投射"),
    ("manual", BASE + "manual/", "使い方（アプリの操作）"),
]

# アプリの配色（styles.css と揃える）
INK = "#1F2933"       # 本文・QRの暗モジュール
ACCENT = "#0B6BCB"    # 操作の青
MAGENTA = "#D81B8C"   # 物体1の打点
SCREEN = "#14181D"    # 動画スクリーンの暗面


def gen_qr():
    """誤り訂正レベルH（30%）で生成。印刷して掲示しても読み取りやすい。"""
    os.makedirs(QR_DIR, exist_ok=True)
    for name, url, label in PAGES:
        qr = segno.make(url, error="h")
        path = os.path.join(QR_DIR, f"{name}.png")
        qr.save(path, scale=8, border=3, dark=INK, light="white")
        print(f"  {name}.png  ({qr.designator})  {label}  {url}")


def _reticle(d, cx, cy, r, color, width):
    """中央十字（照準）— アプリの操作の中心を表す"""
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=width)
    gap = r * 1.02   # 円の外側から腕を出す（円の内側は打点を隠さない）
    arm = r * 1.42
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        d.line([cx + dx * gap, cy + dy * gap, cx + dx * arm, cy + dy * arm],
               fill=color, width=width)


# アイコンの図形は「0〜1の正規化座標」で1か所に定義し、PNGとSVGの両方を
# ここから describe する（二重管理して座標がずれるのを防ぐため）。
RETICLE_R = 0.110   # 照準の半径
RETICLE_W = 0.024   # 照準の線幅
RING = 0.016        # 打点の白フチ


def _icon_layout(simple=False):
    """打点の位置と大きさを返す。simple=True は小サイズ(32px以下)用で、
    照準は潰れて読めないため省き、点を3つに減らして大きく描く。"""
    n = 3 if simple else 5
    span, base, height = (0.58, 0.66, 0.28) if simple else (0.78, 0.64, 0.26)
    dot = 0.105 if simple else 0.050
    pts = []
    for i in range(n):
        t = i / (n - 1)
        x = (1 - span) / 2 + span * t
        y = base - height * (1 - (2 * t - 1) ** 2)   # 上に凸の放物線
        r = dot * (1.0 if simple else (1.25 if i == n // 2 else 1.0))
        pts.append((x, y, r))
    return pts


def _draw_icon(size, bg_radius_ratio=0.22, simple=False):
    """アイコン本体: 暗いスクリーンの上に、放物線の打点列と照準。
    「動画の中の運動に点を打って測る」というアプリの本質をそのまま絵にしたもの。"""
    S = 4  # スーパーサンプリング
    W = size * S
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * bg_radius_ratio), fill=SCREEN)

    pts = _icon_layout(simple)
    ring = W * (0.022 if simple else RING)   # 白フチ（明暗どちらの背景でも浮く）
    for x, y, r in pts:
        cx, cy, rr = x * W, y * W, r * W
        d.ellipse([cx - rr - ring, cy - rr - ring, cx + rr + ring, cy + rr + ring], fill="white")
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=MAGENTA)

    if not simple:
        # 照準（青）は頂点の点に重ねる ＝「十字を合わせて確定」の作法
        cx, cy, _ = pts[len(pts) // 2]
        _reticle(d, cx * W, cy * W, W * RETICLE_R, ACCENT, int(W * RETICLE_W))

    return img.resize((size, size), Image.LANCZOS)


def _build_svg(box=64):
    """PNGと同じレイアウト定義からSVGを組み立てる"""
    def f(v):
        return round(v * box, 1)
    pts = _icon_layout(simple=False)
    dots = "\n".join(
        f'    <circle cx="{f(x)}" cy="{f(y)}" r="{f(r)}"/>' for x, y, r in pts)
    cx, cy, _ = pts[len(pts) // 2]
    r = RETICLE_R
    gap, arm = r * 1.02, r * 1.42
    arms = (f"M{f(cx)} {f(cy - gap)}V{f(cy - arm)}"
            f"M{f(cx)} {f(cy + gap)}V{f(cy + arm)}"
            f"M{f(cx - gap)} {f(cy)}H{f(cx - arm)}"
            f"M{f(cx + gap)} {f(cy)}H{f(cx + arm)}")
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {box} {box}" role="img" aria-label="動画解析トラッカー">
  <rect width="{box}" height="{box}" rx="{f(0.22)}" fill="{SCREEN}"/>
  <g fill="{MAGENTA}" stroke="#FFFFFF" stroke-width="{f(RING) * 2}">
{dots}
  </g>
  <g stroke="{ACCENT}" stroke-width="{f(RETICLE_W)}" fill="none" stroke-linecap="round">
    <circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}"/>
    <path d="{arms}"/>
  </g>
</svg>
"""




def gen_icons():
    os.makedirs(ASSET_DIR, exist_ok=True)
    with open(os.path.join(ASSET_DIR, "favicon.svg"), "w", encoding="utf-8") as f:
        f.write(_build_svg())
    print("  favicon.svg")
    # iOS ホーム画面用（角丸はOS側で付くので、塗りは全面に）
    _draw_icon(180, bg_radius_ratio=0.0).save(os.path.join(ASSET_DIR, "icon-180.png"))
    print("  icon-180.png")
    _draw_icon(512, bg_radius_ratio=0.18).save(os.path.join(ASSET_DIR, "icon-512.png"))
    print("  icon-512.png")
    # SVG非対応ブラウザ向けの小アイコン（タブに表示される実寸）
    _draw_icon(32, bg_radius_ratio=0.18, simple=True).save(os.path.join(ASSET_DIR, "icon-32.png"))
    print("  icon-32.png")


if __name__ == "__main__":
    print("QRコードを生成中:")
    gen_qr()
    print("アイコンを生成中:")
    gen_icons()
    print("完了。")
