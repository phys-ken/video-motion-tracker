# 第三者ライブラリの表示 (Third-Party Notices)

> 本リポジトリで書かれたコード・ドキュメントのライセンスは **MIT**（[LICENSE](LICENSE)）です。
> このファイルは、**`vendor/` に同梱した第三者ライブラリ**について記載しています。

本アプリは外部CDNに接続しません。実行に必要なライブラリは `vendor/` に同梱しています
（学校のネットワークフィルタ下でも動作させるため）。各ライブラリの著作権は原作者に帰属し、
それぞれのライセンスが適用されます。本リポジトリ自身のライセンス（MIT）は `LICENSE` を参照してください。

| ファイル | ライブラリ | バージョン | ライセンス | 配布元 |
|---|---|---|---|---|
| `vendor/xlsx.full.min.js` | SheetJS Community Edition (`xlsx`) | 0.18.5 | Apache License 2.0 | <https://sheetjs.com/> |
| `vendor/mp4box.all.min.js` | MP4Box.js (GPAC) | 2025-03-19 | BSD 3-Clause | <https://github.com/gpac/mp4box.js> |
| `vendor/material-icons-round.woff2`<br>`vendor/material-icons-round.css` | Material Icons (Round) | — | Apache License 2.0 | <https://github.com/google/material-design-icons> |

用途:

- **SheetJS** … 測定データの `.xlsx` 書き出し。
- **MP4Box.js** … 動画コンテナ（MP4 / MOV）を解析して各コマの正確な表示時刻を取得。
  これにより、動画のfpsに依存せず正しい時刻 t を得ています。
- **Material Icons** … 画面のアイコン。

本文の書体は端末に内蔵された書体（ヒラギノ角ゴ、Noto Sans JP 等）を使うため、
Webフォントの同梱・読み込みはありません。

## ライセンス全文

- Apache License 2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- BSD 3-Clause License: <https://opensource.org/license/bsd-3-clause>

## 参考にした先行ソフトウェア（コードの流用はありません）

設計・概念の面で次のソフトウェアを参考にしました。いずれも**コードは使用しておらず**、
本リポジトリにファイルも含めていません。

- **IPhO2023 記念協会「Physics Exam Lab — 動画解析アプリ」**（作: ODA Tomohiro）
  — CC BY-NC 4.0 / <https://apps.ipho2023-commemorative-association.jp/>
- **Open Source Physics「Tracker」/「Tracker Online」**（作: Douglas Brown, OSP / AAPT-ComPADRE）
  — GNU General Public License / <https://opensourcephysics.github.io/tracker-website/>
