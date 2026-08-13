# 動画解析トラッカー (tracker_for_ipad)

動画から物体の運動（位置・速度・加速度）を測定する、**iPad / スマホのブラウザで動く**運動解析ツール。
物理の授業で、生徒一人ひとりが自分の端末で操作することを想定しています。

- 中央十字＋「確定」方式で、指で隠れずに正確に点を打てる（モード切替なし・確定で自動コマ送り）
- 読込直後にコマ数・実FPSをダイアログで提示し、その場で前後の不要コマをカット（正しい時刻 t を保証）
- コマ送りは「プッシュ」遷移＋パラパラ表示で、真っ黒な映像でも進んだことが必ず見える。
  ジョグボタンは長押しで連続送り、映像右上に「現在コマ / 総コマ数」を常設表示
- **打点マップ**: どのコマに座標が決まったかをチップ一覧で表示。タップでそのコマへジャンプ
- 位置に加え速度・加速度グラフ。**グラフをタップで拡大し、範囲をドラッグ選択すると
  その範囲の回帰直線の傾き（v-tなら平均加速度＝重力加速度の測定）を表示**
- TSVコピー＋xlsxダウンロード、ストロボ写真PNG（残像合成／点マーカーの2モード）、
  Undo（何が消えたかを表示）＋自動保存
- 打点はマゼンタ系の高視認色（実写映像とかぶらない・色覚多様性対応のパレット）
- 白ベースの明るいUI（教室の昼間・プロジェクタ投影を想定）。iPad横向き推奨、スマホ縦でも利用可
- スロー動画の時間補正、長い動画を誤って読み込んでもクラッシュしない設計

## 使い方
- 生徒: 公開ページ **<https://phys-ken.github.io/tracker-for-ipad/>** を開くだけ
  （インストール不要、動画は端末内で処理されサーバーには送信されません）。
- 授業用の**実験手順書サイト**（自由落下・鉛直投げ上げ・水平投射・斜方投射）:
  **<https://phys-ken.github.io/tracker-for-ipad/guide/>**（アプリからはリンクしていません。
  配布はこのURLを直接どうぞ。印刷にも対応しています）。
- ローカル: `python serve.py` → `http://localhost:8000`。

詳しい操作は **[MANUAL.md](MANUAL.md)** を参照。
設計方針・ビジュアルの考え方は **[DESIGN.md](DESIGN.md)** にまとめています。

## 構成
| ファイル | 役割 |
|---|---|
| `index.html` | 画面構造 |
| `app.js` | 解析ロジック（トラッキング/校正/FPS実測/グラフ/出力） |
| `styles.css` | 白ベースのビジュアル（教室昼間・色覚多様性対応パレット） |
| `guide/` | 生徒向け実験手順書サイト（4種の落体運動・相互ナビ付き） |
| `samples/` + `tools/gen_samples.py` | 真値既知の合成サンプル動画とジェネレータ |
| `serve.py` | ローカル開発サーバ（:8000, LAN公開, キャッシュ無効） |
| `test_logic.js` / `tests/` / `test.html` | テスト（node ロジック / 実Chrome E2E・精度 / ブラウザ内ハーネス） |

## テスト
依存パッケージはありません。

- `npm test` … node によるロジック単体テスト
- `node tests/e2e.test.js` … 既存 Chrome を DevTools Protocol で駆動する E2E（動画を実デコードして検証）
- `test.html` … `python serve.py` 後にブラウザ（iPad/Safari 可）で開いて目視

## ライセンス
本リポジトリのコード（`index.html` / `app.js` / `styles.css` / `serve.py` / テスト類）は
**Creative Commons 表示-非営利 4.0 国際（CC BY-NC 4.0）** で公開します。© 2026 phys-ken。
全文は [LICENSE](LICENSE) を参照。商用利用を希望される場合は作者へご連絡ください。

同梱している外部ライブラリ（CDN 依存はありません。学校のMDMフィルタ下でも動作します）:
- Material Icons — Apache License 2.0
- SheetJS (xlsx) — Apache License 2.0
- mp4box.js — BSD-3-Clause（GPAC）

本文フォントは端末ネイティブ書体（ヒラギノ角ゴ等）を使用します。

## クレジット / 謝辞
本アプリは独立実装ですが、設計・概念の面で次の優れた先行ソフトウェアから着想を得ました。
**コードの流用はありません。** これらのリファレンス・ファイルは本リポジトリには含めていません。

- **IPhO2023 記念協会「Physics Exam Lab — 動画解析アプリ」**（作: ODA Tomohiro）
  © 2025 一般社団法人 国際物理オリンピック2023記念協会 — CC BY-NC 4.0
  <https://apps.ipho2023-commemorative-association.jp/動画解析アプリ>
- **Open Source Physics「Tracker」/「Tracker Online」**（作: Douglas Brown, OSP / AAPT-ComPADRE）
  GNU General Public License — <https://opensourcephysics.github.io/tracker-website/>
