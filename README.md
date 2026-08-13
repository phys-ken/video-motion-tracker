# 動画解析トラッカー (tracker_for_ipad)

動画から物体の運動（位置・速度・加速度）を測定する、**iPad / スマホのブラウザで動く**運動解析ツール。
物理の授業で、生徒一人ひとりが自分の端末で操作することを想定しています。

- 中央十字＋「確定」方式で、指で隠れずに正確に点を打てる（モード切替なし）
- 読込直後にコマ数・実FPSを提示し、前後の不要コマのカットを案内（正しい時刻 t を保証）
- 10コマ送りは中間コマをパラパラ表示、ジョグボタンは長押しで連続送り
- 位置に加え速度・加速度グラフ（v-tグラフは回帰直線の傾き＝平均加速度を常時表示）、
  表・グラフ・動画の連動ハイライト
- TSVコピー＋xlsxダウンロード、ストロボ写真PNG、Undo＋自動保存
- 白ベースの明るいUI（教室の昼間・プロジェクタ投影を想定）。iPad横向き推奨、スマホ縦でも利用可

## 使い方
- 生徒: 公開ページ **<https://phys-ken.github.io/tracker-for-ipad/>** を開くだけ
  （インストール不要、動画は端末内で処理されサーバーには送信されません）。
- ローカル: `python serve.py` → `http://localhost:8000`。

詳しい操作は **[MANUAL.md](MANUAL.md)** を参照。
設計方針・ビジュアルの考え方は **[DESIGN.md](DESIGN.md)** にまとめています。

## 構成
| ファイル | 役割 |
|---|---|
| `index.html` | 画面構造 |
| `app.js` | 解析ロジック（トラッキング/校正/FPS実測/グラフ/出力） |
| `styles.css` | "計器/ストロボ" のビジュアル |
| `serve.py` | ローカル開発サーバ（:8000, LAN公開, キャッシュ無効） |
| `test_logic.js` / `tests/e2e.test.js` / `test.html` | テスト（node ロジック / 実Chrome E2E / ブラウザ内ハーネス） |

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
