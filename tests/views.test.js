// Physics Tracker - tests/views.test.js
// 画面幅ごとの通し検証。PC / タブレット横 / タブレット縦 / スマホ の4つで、
//   起動パネル → 運動の種類を選ぶ → 動画読込 → スケール設定ステップ
//   → 追跡 → グラフ → 拡大して傾き → 提出用レポート
// までを実際に走らせ、レイアウト崩れ（横スクロール・パネルの重なり・画面外への
// はみ出し）と、物理の値が正しいことを機械的に確かめる。
//   実行:  node tests/views.test.js
//   任意:  VIEWS_SHOTS=/path/to/dir を付けるとスクリーンショットも保存する
//
// 目視では見落とす類の不具合（右パネルが押し潰されて重なる、確定ボタンから
// 文字がはみ出す、目盛りが説明文に食い込む等）を、実際に3件見つけている。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_DIR = process.env.VIEWS_SHOTS || null;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.error('  ❌ ' + msg); } };

const VIEWS = [
    { key: 'pc',       label: 'PC (1440x900)',              w: 1440, h: 900,  mobile: false },
    { key: 'tablet',   label: 'タブレット横 (1024x768)',     w: 1024, h: 768,  mobile: false },
    { key: 'tablet-p', label: 'タブレット縦 (820x1180)',     w: 820,  h: 1180, mobile: true  },
    { key: 'phone',    label: 'スマホ (390x844)',            w: 390,  h: 844,  mobile: true  }
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
    return new Promise(res => {
        const srv = http.createServer((req, resp) => {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            const fp = path.join(ROOT, p);
            if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
                resp.writeHead(404); resp.end('not found'); return;
            }
            resp.writeHead(200, {
                'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
                'Cache-Control': 'no-cache'
            });
            resp.end(fs.readFileSync(fp));
        });
        srv.listen(0, '127.0.0.1', () => res(srv));
    });
}
const httpGet = (u) => new Promise((res, rej) => {
    http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

class CDP {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map();
        ws.addEventListener('message', ev => {
            const m = JSON.parse(ev.data);
            if (m.id && this.pending.has(m.id)) {
                const { resolve, reject } = this.pending.get(m.id);
                this.pending.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
        });
    }
    send(method, params = {}, sessionId) {
        const id = ++this.id;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg));
        });
    }
}
async function ev(cdp, S, body) {
    const r = await cdp.send('Runtime.evaluate',
        { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) {
        const x = r.exceptionDetails.exception;
        throw new Error('ページ内例外: ' + (x && (x.description || x.value) || ''));
    }
    return r.result.value;
}

(async () => {
    console.log('=== ビュー別チェック (実Chrome / DevTools Protocol) 開始 ===');
    const srv = await startServer();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-views-'));
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
        '--force-device-scale-factor=2', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
        { stdio: 'ignore' });
    let ws;
    try {
        const portFile = path.join(udd, 'DevToolsActivePort');
        const t0 = Date.now();
        while (!fs.existsSync(portFile)) {
            if (Date.now() - t0 > 12000) throw new Error('DevToolsActivePort 未生成');
            await sleep(100);
        }
        const port = parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10);
        const info = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
        ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        const cdp = new CDP(ws);
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Page.enable', {}, S);
        await cdp.send('Runtime.enable', {}, S);

        const shot = async (name) => {
            if (!SHOT_DIR) return;
            const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
        };

        for (const V of VIEWS) {
            console.log(`\n--- ${V.label} ---`);
            await cdp.send('Emulation.setDeviceMetricsOverride',
                { width: V.w, height: V.h, deviceScaleFactor: 2, mobile: V.mobile }, S);
            await cdp.send('Page.navigate', { url: `${base}/?v=${V.key}` }, S);
            await sleep(1600);
            await ev(cdp, S, `localStorage.clear(); location.reload();`);
            await sleep(1600);

            // --- 起動パネル: 選ぶまで動画を読み込ませない ---
            const panel = await ev(cdp, S, `
                const ov = document.getElementById('mode-overlay');
                const r = document.querySelector('.mode-panel').getBoundingClientRect();
                return { shown: getComputedStyle(ov).display !== 'none',
                         cards: document.querySelectorAll('#mode-grid .mode-card').length,
                         custom: document.querySelectorAll('#mode-grid [data-mode="custom"]').length,
                         customWide: (() => { const c = document.querySelector('[data-mode="custom"]');
                             const g = document.getElementById('mode-grid');
                             return !!c && Math.abs(c.getBoundingClientRect().width - g.getBoundingClientRect().width) < 4; })(),
                         sampleDisabled: document.getElementById('mode-btn-sample').disabled,
                         fileDisabled: document.getElementById('mode-btn-file').classList.contains('is-disabled'),
                         fits: r.left >= -1 && r.right <= innerWidth + 1 && r.height <= innerHeight + 1,
                         w: Math.round(r.width), h: Math.round(r.height) };`);
            ok(panel.shown && panel.cards === 5, `起動パネルが4種＋カスタムで出る (${panel.w}x${panel.h})`);
            ok(panel.custom === 1 && panel.customWide, 'カスタムは2列ぶち抜きで4種と分けて見せる');
            ok(panel.sampleDisabled && panel.fileDisabled, '選ぶまで読み込みボタンは押せない');
            ok(panel.fits, `パネルが画面に収まる (${V.w}x${V.h})`);
            await shot(`${V.key}_1_mode.png`);

            // --- 種類を選ぶと軸とグラフが決まる ---
            const picked = await ev(cdp, S, `
                document.querySelector('[data-mode="vertical-throw"]').click();
                await new Promise(r => setTimeout(r, 120));
                return { mode: appState.motionMode,
                         sampleDisabled: document.getElementById('mode-btn-sample').disabled,
                         chip: document.getElementById('mode-chip-name').textContent,
                         axis: document.getElementById('mode-chip-axis').textContent,
                         graphs: [...document.querySelectorAll('#graph-type-checklist input:checked')].map(b => b.value).join(',') };`);
            ok(picked.mode === 'vertical-throw' && !picked.sampleDisabled, '選ぶと読み込みボタンが有効になる');
            ok(picked.chip === '鉛直投げ上げ' && picked.axis === '上向きが正', `手順ガイドに反映 (${picked.chip} / ${picked.axis})`);
            ok(picked.graphs === 'y-t,vy-t', `既定グラフが切り替わる (${picked.graphs})`);

            // --- 動画読込 → スケール設定ステップに入る ---
            await ev(cdp, S, `
                window.closeModePanel();
                await window.loadSampleByUrl('samples/vertical_throw.mp4','vertical_throw.mp4');`);
            for (let i = 0; i < 100; i++) {
                if (await ev(cdp, S, `return !appState.isScanning && appState.totalFrames>0;`)) break;
                await sleep(250);
            }
            await ev(cdp, S, `
                const okBtn = document.getElementById('dialog-btn-ok');
                if (okBtn && document.getElementById('dialog-overlay').style.display === 'flex') okBtn.click();
                await new Promise(r => setTimeout(r, 400));`);
            await sleep(400);
            const step = await ev(cdp, S, `
                const b = document.getElementById('scale-banner');
                const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
                const r = b.getBoundingClientRect();
                return { banner: !b.hidden, calib: document.body.classList.contains('calibrating'),
                         redo: vis('btn-scale-redo'), jogHidden: !vis('btn-prev-1') && !vis('btn-next-1'),
                         label: document.querySelector('.confirm-label').textContent,
                         skip: vis('scale-banner-skip'),
                         fits: r.left >= -1 && r.right <= innerWidth + 1,
                         step: document.getElementById('scale-banner-step').textContent };`);
            ok(step.banner && step.calib, 'スケール設定ステップに自動で入り、帯と枠の色が変わる');
            ok(step.redo && step.jogHidden, '下部バーが「やり直す＋確定」だけになる（打点ボタンが消える）');
            ok(/スケール/.test(step.label), `確定ボタンがスケール用の文言 (${step.label})`);
            ok(step.skip && step.fits, `逃げ道リンクが出て、帯が画面に収まる (${step.step})`);
            await shot(`${V.key}_2_scale.png`);

            // --- スケールを決めると通常のバーに戻る ---
            await ev(cdp, S, `
                const s = appState;
                s.calibration.scaleStart = {x:20,y:930}; s.calibration.scaleEnd = {x:520,y:930};
                s.calibration.scaleActual = 100; s.calibration.scaleRatio = 0.2; s.scaleSkipped = false;
                document.getElementById('info-scale').textContent = '0.200 cm/px';
                window.setPendingCapture(null); window.updateScaleBanner(); window.updateStepGuide();
                window.__suppressTrimDialog = true;`);
            const left = await ev(cdp, S, `
                return { banner: !document.getElementById('scale-banner').hidden,
                         calib: document.body.classList.contains('calibrating'),
                         jog: getComputedStyle(document.getElementById('btn-prev-1')).display !== 'none',
                         warn: !document.getElementById('scale-warn-chip').hidden };`);
            ok(!left.banner && !left.calib && left.jog, 'スケールを決めると帯が消えて通常のバーに戻る');
            ok(!left.warn, 'スケール設定済みなら警告チップは出ない');

            // --- 追跡（色検出で自動）→ グラフ ---
            const n = await ev(cdp, S, `
                const s = appState, v = s.videoElement;
                const cv = document.createElement('canvas'); cv.width = 540; cv.height = 960;
                const cx = cv.getContext('2d', { willReadFrequently: true });
                const seek = (k) => new Promise(r => { let d = false;
                    const h = () => { if (d) return; d = true; v.removeEventListener('seeked', h); r(); };
                    v.addEventListener('seeked', h); window.seekToFrame(k);
                    setTimeout(() => { if (!d) { d = true; v.removeEventListener('seeked', h); r(); } }, 2000); });
                s.trackingData = []; s.activeObjectId = 1;
                const N = Math.min(53, s.totalFrames);
                for (let k = 0; k <= N; k += 2) {
                    await seek(k); await new Promise(r => setTimeout(r, 35));
                    cx.drawImage(v, 0, 0, 540, 960);
                    const d = cx.getImageData(0, 0, 540, 960).data;
                    let sx = 0, sy = 0, c = 0;
                    for (let i = 0; i < d.length; i += 4) {
                        if (d[i] > 140 && d[i+1] > 140 && d[i+2] < 110) { sx += (i/4) % 540; sy += Math.floor((i/4)/540); c++; }
                    }
                    if (c > 0) s.trackingData.push({ id: 3000+k, frame: k, time: window.frameTimeOf(k), x: sx/c, y: sy/c, objectId: 1 });
                }
                window.updateDataTable(); window.updateGraph(); window.drawVideoFrame();
                window.seekToFrame(14);
                return s.trackingData.length;`);
            ok(n > 20, `追跡点 ${n} 点を記録`);
            await sleep(500);
            await shot(`${V.key}_3_work.png`);

            // --- 物理が正しいか（画面幅に依存しないはずの値） ---
            const phys = await ev(cdp, S, `
                const data = appState.trackingData.slice().sort((a,b) => a.frame - b.frame);
                const kin = window.computeKinematics(data);
                const xs = kin.map(k => k.t), ys = kin.map(k => k.vy);
                const m = xs.length, mx = xs.reduce((a,b)=>a+b,0)/m, my = ys.reduce((a,b)=>a+b,0)/m;
                let sxx = 0, sxy = 0;
                for (let i = 0; i < m; i++) { sxx += (xs[i]-mx)**2; sxy += (xs[i]-mx)*(ys[i]-my); }
                return { g: +(sxy/sxx/100).toFixed(3), first: +ys[0].toFixed(0), last: +ys[m-1].toFixed(0),
                         originZero: Math.abs(kin[0].x) < 1e-9 && Math.abs(kin[0].y) < 1e-9 };`);
            ok(Math.abs(phys.g + 9.8) / 9.8 < 0.05, `v-t の傾き = ${phys.g} m/s² (真値 -9.8 の5%以内)`);
            ok(phys.first > 0 && phys.last < 0, `上向きが正になっている (最初 ${phys.first} → 最後 ${phys.last} cm/s)`);
            ok(phys.originZero, '原点が最初の打点になっている');

            // --- レイアウト: 横スクロールとパネルの重なり ---
            const lay = await ev(cdp, S, `
                window.scrollTo(0,0); await new Promise(r => setTimeout(r, 150));
                const sb = document.querySelector('.sidebar-section');
                // 2カラム表示では横に並ぶのが正しいので、矩形が実際に重なった場合だけ検出する
                const kids = [...sb.children].map(e => { const r = e.getBoundingClientRect();
                    return { cls: e.className.slice(0,20), t: r.top+scrollY, b: r.bottom+scrollY, l: r.left, r: r.right }; });
                let overlap = null;
                for (let i = 0; i < kids.length; i++) for (let j = i+1; j < kids.length; j++) {
                    const A = kids[i], B = kids[j];
                    const dy = Math.min(A.b,B.b) - Math.max(A.t,B.t);
                    const dx = Math.min(A.r,B.r) - Math.max(A.l,B.l);
                    if (dy > 2 && dx > 2) overlap = A.cls + ' / ' + B.cls + ' (' + Math.round(dx) + 'x' + Math.round(dy) + 'px)';
                }
                const el = document.documentElement;
                return { hScroll: el.scrollWidth > el.clientWidth + 1, overlap,
                         chip: document.getElementById('mode-chip').getBoundingClientRect().width > 0 };`);
            ok(!lay.hScroll, 'ページが横スクロールしない');
            ok(!lay.overlap, lay.overlap ? `パネルが重なっている: ${lay.overlap}` : '右パネルが重ならずに積まれる');
            ok(lay.chip, '運動モードのチップが表示されている');

            // --- グラフ拡大: 傾きと R² が読め、画面に収まる ---
            await ev(cdp, S, `window.openGraphDialog('vy-t'); await new Promise(r => setTimeout(r, 500));`);
            await sleep(400);
            const dlg = await ev(cdp, S, `
                const ro = document.getElementById('ggd-readout');
                const d = document.querySelector('.dialog').getBoundingClientRect();
                return { text: ro.textContent.replace(/\\s+/g,' ').trim(),
                         hasR2: /R²/.test(ro.textContent),
                         fits: d.left >= -1 && d.right <= innerWidth + 1 };`);
            ok(dlg.hasR2, `拡大画面に R² が出る (${dlg.text.slice(0, 48)})`);
            ok(dlg.fits, '拡大ダイアログが画面に収まる');
            await shot(`${V.key}_4_dialog.png`);
            await ev(cdp, S, `document.getElementById('dialog-btn-ok').click();`);
            await sleep(300);

            // --- 提出用レポート: A4縦・照合コード・平均加速度 ---
            const rep = await ev(cdp, S, `
                const strobe = document.createElement('canvas');
                const n = await window.generateStrobe(strobe, 2, 60, null, 'dots');
                const verify = await window.computeVerificationCode();
                const out = document.createElement('canvas');
                await window.composeReport(out, strobe, verify);
                const d = out.getContext('2d').getImageData(4, 4, 1, 1).data;
                if (${SHOT_DIR ? 'true' : 'false'}) window.__reportURL = out.toDataURL('image/png');
                return { n, code: verify.code, w: out.width, h: out.height,
                         ratio: +(out.height / out.width).toFixed(3),
                         white: d[0] > 240 && d[1] > 240 && d[2] > 240 };`);
            ok(rep.n > 5, `レポート用ストロボを合成 (${rep.n}コマ)`);
            ok(Math.abs(rep.ratio - Math.SQRT2) < 0.01, `レポートがA4縦の比率 (${rep.w}x${rep.h})`);
            ok(rep.white, 'レポートの背景が白（印刷向き）');
            ok(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(rep.code), `照合コード ${rep.code}`);
            if (SHOT_DIR) {
                const durl = await ev(cdp, S, `return window.__reportURL;`);
                fs.mkdirSync(SHOT_DIR, { recursive: true });
                fs.writeFileSync(path.join(SHOT_DIR, `${V.key}_5_report.png`),
                    Buffer.from(durl.split(',')[1], 'base64'));
            }

            // --- 打点を残したまま開き直す（共用iPadで前の人の作業が残っている状況） ---
            // 起動パネルは必ず出て、前回の種類は選択済みにならない（黙って引き継がない）
            await ev(cdp, S, `window.persistState(); return true;`);
            await ev(cdp, S, `location.reload();`);
            await sleep(1600);
            const again = await ev(cdp, S, `
                const ov = document.getElementById('mode-overlay');
                return { shown: getComputedStyle(ov).display !== 'none',
                         active: document.querySelectorAll('#mode-grid .mode-card.active').length,
                         sampleDisabled: document.getElementById('mode-btn-sample').disabled,
                         foot: document.getElementById('mode-foot').textContent };`);
            ok(again.shown && again.active === 0 && again.sampleDisabled,
                '打点が残っていても起動パネルが出て、種類は未選択に戻る');
            ok(/前回の打点/.test(again.foot) && /戻す/.test(again.foot), `残っている打点と「戻す」の案内が出る (${again.foot.slice(0, 30)}…)`);
        }
    } catch (e) {
        fail++;
        console.error('❌ 実行エラー: ' + e.message);
    } finally {
        try { if (ws) ws.close(); } catch (e) {}
        try { proc.kill(); } catch (e) {}
        try { srv.close(); } catch (e) {}
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
    }
    console.log(`\n=== ビュー別チェック 終了: ${pass} PASS / ${fail} FAIL ===`);
    if (SHOT_DIR) console.log(`スクリーンショット: ${SHOT_DIR}`);
    process.exit(fail === 0 ? 0 : 1);
})();
