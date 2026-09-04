# video-motion-tracker — 作業メモ（Claude Code 用）

高校物理の落体運動（自由落下・鉛直投げ上げ・水平投射・斜方投射）を動画から測る、
ビルド無しの静的 Web アプリ。設計の理由は DESIGN.md、使い方は MANUAL.md にある。

## 構成
- `app.js`（単一ファイル、約4,700行）／`index.html`／`styles.css`。フレームワーク・バンドラ無し。
- 依存ライブラリは `vendor/` に同梱（SheetJS, MP4Box.js, Material Icons）。CDN は使わない。
- 配布は GitHub Pages（main を直接配信）。`samples/` は `tools/gen_samples.py` で生成した真値既知の合成動画。

## 必ず守ること
- 版数を上げるときは 3 か所を同じ文字列にする: `app.js` の `APP_VERSION`、
  `index.html` の `app.js?v=` と `styles.css?v=`。GitHub Pages はキャッシュ制御が効かない。
- 物理座標は「最初の打点が原点」「モードが軸の符号を決める」（`originOf` / `physCoordOf`）。
  ここを触るときは `test_logic.js` の軸テストも見る。
- 速度・加速度の平滑化（`kinematicsWindow`, `ACCEL_EDGE_DROP`）とフレーム時刻表
  （`dedupTimesByPixel`）は精度テストで守られている。定数を変えたら `npm run test:precision`。
- 本番前の大きなリファクタ（app.js の分割など）はしない。
- UI の見た目を変えたら `npm run shots` で `manual/img/` と `manual/manual.pdf` を作り直す。
  使い方ページの画面写真は手で撮らない（`tools/gen_manual_shots.js` が唯一の出どころ）。
  押す場所の赤枠も、その中で付けている（画像編集ソフトを使わない）。

## テスト
```
export CHROME_BIN=/usr/bin/google-chrome
npm test                # ロジック単体（Node）
npm run test:e2e        # 実 Chrome を DevTools Protocol で駆動（40）
npm run test:precision  # 真値既知動画で g を測る（6）
npm run test:views      # PC/タブレット横/縦/スマホの通し（100+）
npm run test:ipad       # iPadのUA・タッチ・回転・保存の通し（23）
npm run test:all
```
Chrome 系でしか動かない。iPad Safari の挙動（HEVC・回転・保存先）は実機でしか確認できない。
テスト用フック: `window.__suppressModePanel` / `window.__suppressTrimDialog` / `window.loadSampleByUrl`。

## 環境の癖
- Python は `uv venv` で仮想環境を作って使う（numpy, opencv, ffmpeg が要る）。
- コミットメッセージは日本語、prefix は feat/fix/docs/chore。
