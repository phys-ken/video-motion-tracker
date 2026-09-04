// マニュアル用スクリーンショット生成
//   実行:  CHROME_BIN=/usr/bin/google-chrome node tools/gen_manual_shots.js
//   出力:  manual/img/*.png
//
// iPad 縦（820x1180 / 2倍）で自由落下サンプルを一通り操作し、各手順の
// 「見てほしいところだけ」を切り出して保存する。画面全体を貼ると字が小さくなり、
// どこを見ればいいのか分からなくなるため、必ず該当箇所へ寄せる。
// アプリのUIを変えたらこれを流し直すこと（古いスクショはマニュアルの寿命を縮める）。
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'manual', 'img');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function startServer() { return new Promise(res => { const s = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    r.end(fs.readFileSync(fp)); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
const httpGet = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); });
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
        if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
            m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }); }
  send(method, params = {}, S) { const id = ++this.id; const msg = { id, method, params };
    if (S) msg.sessionId = S;
    return new Promise((rs, rj) => { this.p.set(id, { resolve: rs, reject: rj }); this.ws.send(JSON.stringify(msg)); }); } }

(async () => {
    const srv = await startServer();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-'));
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
        '--no-first-run', '--disable-gpu', '--mute-audio', '--force-color-profile=srgb',
        '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
    let ws, made = 0;
    try {
        const pf = path.join(udd, 'DevToolsActivePort'); const t0 = Date.now();
        while (!fs.existsSync(pf)) { if (Date.now() - t0 > 12000) throw new Error('DevToolsActivePort 未生成'); await sleep(100); }
        const port = parseInt(fs.readFileSync(pf, 'utf8').split('\n')[0], 10);
        const info = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
        ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        const cdp = new CDP(ws);
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Page.enable', {}, S); await cdp.send('Runtime.enable', {}, S);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }, S);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
        // iPad として名乗らせる。保存ボタンの文言が端末で変わるため（PCだと「画像を保存」、
        // iPad だと「画像を共有・保存」）、実際に生徒が見る方を写す。
        await cdp.send('Network.setUserAgentOverride', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
                       '(KHTML, like Gecko) Version/18.5 Safari/605.1.15', platform: 'iPad' }, S);

        const ev = async body => {
            const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }, S);
            if (r.exceptionDetails) { const x = r.exceptionDetails.exception; throw new Error('ページ内例外: ' + ((x && (x.description || x.value)) || '')); }
            return r.result.value;
        };
        fs.mkdirSync(OUT, { recursive: true });

        // Tango のマニュアルのように、操作する場所を赤枠と矢印で示してから撮る。
        // 画像の中に「どこを押すのか」が入っていれば、本文を読まなくても通じる。
        // 枠だけだとアプリの装飾と見分けがつかないので、太くして矢印も添える。
        const MARK_JS = `
            window.__mark = function (rect) {
                const R = 6, PAD = 6, COL = '#E5484D';
                const box = document.createElement('div');
                box.setAttribute('data-manual-mark', '1');
                box.style.cssText = 'position:absolute;pointer-events:none;z-index:99999;' +
                    'border:' + R + 'px solid ' + COL + ';border-radius:' + (rect.round || 10) + 'px;' +
                    'box-shadow:0 0 0 3px rgba(255,255,255,.85), 0 0 0 6px rgba(229,72,77,.25);' +
                    'left:' + (rect.x - PAD) + 'px;top:' + (rect.y - PAD) + 'px;' +
                    'width:' + (rect.w + PAD * 2) + 'px;height:' + (rect.h + PAD * 2) + 'px;';
                document.body.appendChild(box);
                // 余白のある側から矢印を引く。どこにも余地が無ければ矢印は出さない。
                if (rect.arrow === false) return;
                const L = 66, room = 82;
                const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
                let dir = rect.dir || null;
                if (dir) { /* 指定があればそれに従う */ }
                else if (rect.x - scrollX > room) dir = 'left';
                else if (innerWidth - (rect.x + rect.w - scrollX) > room) dir = 'right';
                else if (rect.y - scrollY > room) dir = 'top';
                else if (innerHeight - (rect.y + rect.h - scrollY) > room) dir = 'bottom';
                if (!dir) return;
                let x1, y1, x2, y2;
                if (dir === 'left')  { x1 = rect.x - PAD - L; y1 = cy; x2 = rect.x - PAD - 10; y2 = cy; }
                if (dir === 'right') { x1 = rect.x + rect.w + PAD + L; y1 = cy; x2 = rect.x + rect.w + PAD + 10; y2 = cy; }
                if (dir === 'top')   { x1 = cx; y1 = rect.y - PAD - L; x2 = cx; y2 = rect.y - PAD - 10; }
                if (dir === 'bottom'){ x1 = cx; y1 = rect.y + rect.h + PAD + L; x2 = cx; y2 = rect.y + rect.h + PAD + 10; }
                // 矢印は「軸と頭を1つの図形」として描く。線と marker を別々に描くと、
                // marker の大きさが線の太さに比例して拡大され、白と赤で先端がずれる。
                const pad = 26;
                const minX = Math.min(x1, x2) - pad, minY = Math.min(y1, y2) - pad;
                const w = Math.abs(x2 - x1) + pad * 2, h = Math.abs(y2 - y1) + pad * 2;
                const len = Math.hypot(x2 - x1, y2 - y1);
                const deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
                const t = 5, hl = 21, hw = 12.5;      // 軸の半太さ / 頭の長さ / 頭の半幅
                const d = 'M0,' + (-t) + ' L' + (len - hl) + ',' + (-t) +
                          ' L' + (len - hl) + ',' + (-hw) + ' L' + len + ',0' +
                          ' L' + (len - hl) + ',' + hw + ' L' + (len - hl) + ',' + t + ' L0,' + t + ' Z';
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('data-manual-mark', '1');
                svg.setAttribute('width', w); svg.setAttribute('height', h);
                svg.style.cssText = 'position:absolute;pointer-events:none;z-index:99999;' +
                    'left:' + minX + 'px;top:' + minY + 'px;overflow:visible;';
                const g = '<g transform="translate(' + (x1 - minX) + ',' + (y1 - minY) + ') rotate(' + deg + ')">';
                svg.innerHTML = g +
                    '<path d="' + d + '" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="7" stroke-linejoin="round"/>' +
                    '<path d="' + d + '" fill="' + COL + '"/></g>';
                document.body.appendChild(svg);
            };`;
        // 複数を囲むときは矢印を出さない（隣の枠や文字に矢が重なるため）
        const markOn = (sels, dir) => ev(MARK_JS +
            'const list = ' + JSON.stringify(sels) + ';' +
            'const one = list.length === 1;' +
            'for (const s of list) {' +
            '  const e = document.querySelector(s); if (!e) continue;' +
            '  const r = e.getBoundingClientRect();' +
            '  window.__mark({x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,' +
            '                 round: 10, arrow: one, dir: ' + JSON.stringify(dir || null) + '});' +
            '}' +
            'await new Promise(r=>setTimeout(r,80));');

        // 映像の上の十字は要素ではないので、画面中央を丸で囲う
        const markCrosshair = (size, dir) => ev(MARK_JS +
            'const S = ' + (size || 74) + ';' +
            'const r = document.getElementById("tracker-canvas").getBoundingClientRect();' +
            'window.__mark({x: r.left + scrollX + r.width/2 - S/2, y: r.top + scrollY + r.height/2 - S/2,' +
            '               w: S, h: S, round: S, dir: ' + JSON.stringify(dir || 'top') + '});' +
            'await new Promise(r=>setTimeout(r,80));');

        const markOff = () => ev(
            'document.querySelectorAll("[data-manual-mark]").forEach(e => e.remove());' +
            'await new Promise(r=>setTimeout(r,40));');

        // sel で指定した要素を囲む矩形だけを切り出す（pad は余白px）
        const shot = async (name, sel, pad = 10) => {
            const box = await ev(`
                const els = ${JSON.stringify(sel)}.map(s => document.querySelector(s)).filter(Boolean)
                    .concat([...document.querySelectorAll('[data-manual-mark]')]);
                if (!els.length) return null;
                // 画面の外にある要素は、いったん見える位置へ送ってから測る
                // （描画が画面内でしか走らない部品があるため）
                els[0].scrollIntoView({block:'center'});
                await new Promise(r=>setTimeout(r,250));
                let l=1e9,t=1e9,r=-1e9,b=-1e9;
                for (const e of els) { const q=e.getBoundingClientRect();
                    l=Math.min(l,q.left); t=Math.min(t,q.top); r=Math.max(r,q.right); b=Math.max(b,q.bottom); }
                // clip はページ座標なので、スクロール量を足す（画面の下にある要素対策）
                return {x:l+scrollX, y:t+scrollY, w:r-l, h:b-t};`);
            if (!box) { console.warn('  (見つからず) ' + name); return; }
            // 表示は最大 380px 幅なので、2倍相当（760px）あれば十分。
            // これ以上大きくしても、リポジトリと通信量が増えるだけ。
            const w = box.w + pad * 2;
            const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
                           width: w, height: box.h + pad * 2,
                           scale: Math.min(2, Math.max(1, 760 / w)) };
            const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, S);
            const fp = path.join(OUT, name);
            fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
            const kb = fs.statSync(fp).size / 1024;
            console.log(`  ${name}  ${Math.round(clip.width)}x${Math.round(clip.height)}  ${kb.toFixed(0)}KB`);
            made++;
        };

        // 映像の中の1点に十字を合わせると、その点が画面の端に近いほど、映像が画面の外へ
        // はみ出して黒い余白が広く写る（サンプルのものさしは画面の端いっぱいにある）。
        // マニュアルでは十字まわりだけを接写して、何をしているかが分かる絵にする。
        const shotAroundCrosshair = async (name, dx, dy, w, h) => {
            const c = await ev(`
                const r = document.getElementById('tracker-canvas').getBoundingClientRect();
                return {cx: r.left + scrollX + r.width/2, cy: r.top + scrollY + r.height/2};`);
            const clip = { x: c.cx + dx, y: c.cy + dy, width: w, height: h,
                           scale: Math.min(2, Math.max(1, 760 / w)) };
            const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, S);
            const fp = path.join(OUT, name);
            fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
            console.log(`  ${name}  ${w}x${h}  ${(fs.statSync(fp).size / 1024).toFixed(0)}KB`);
            made++;
        };

        // 映像内の座標が画面中央（＝十字の位置）に来るように視点を動かす。
        // 実際に生徒がやる「対象に十字を合わせる」状態を再現するため。
        const centerOn = (vx, vy) => ev(
            'const m = window.getFitMetrics();' +
            'const c = appState.canvas, s = appState.viewState.scale;' +
            'appState.viewState.offsetX = c.width/2  - s*(m.baseX + m.fit*' + vx + ');' +
            'appState.viewState.offsetY = c.height/2 - s*(m.baseY + m.fit*' + vy + ');' +
            'window.drawVideoFrame();' +
            'await new Promise(r=>setTimeout(r,200));');

        console.log('マニュアル用スクリーンショットを生成:');
        await cdp.send('Page.navigate', { url: base + '/' }, S); await sleep(1500);
        await ev(`localStorage.clear();location.reload();`); await sleep(1600);

        // ① 運動の種類を選ぶ
        await markOn(['[data-mode="free-fall"]']);
        await shot('01_mode.png', ['.mode-panel'], 0);
        await markOff();

        // ② 動画を読み込む（サンプル）
        await ev(`document.querySelector('[data-mode="free-fall"]').click();
                  await new Promise(r=>setTimeout(r,150));`);
        await markOn(['#mode-btn-file', '#mode-btn-sample']);
        await shot('02_pick.png', ['.mode-actions', '.mode-foot'], 26);
        await markOff();

        await ev(`window.closeModePanel();
                  await window.loadSampleByUrl('samples/free_fall.mp4','free_fall.mp4');`);
        for (let i = 0; i < 120; i++) { if (await ev(`return !appState.isScanning && appState.totalFrames>0;`)) break; await sleep(250); }
        await sleep(700);

        // ③ 使う範囲を決める
        await ev(`window.seekToFrame(24); await new Promise(r=>setTimeout(r,500));
                  document.getElementById('trim-set-in').click(); await new Promise(r=>setTimeout(r,200));
                  window.seekToFrame(58); await new Promise(r=>setTimeout(r,500));
                  document.getElementById('trim-set-out').click(); await new Promise(r=>setTimeout(r,300));`);
        await markOn(['#trim-set-in', '#trim-set-out']);
        await shot('03b_trim_controls.png', ['.trim-slider', '.trim-frame', '.trim-jog', '.trim-set-row', '.trim-range'], 20);
        await markOff();
        await ev(`document.getElementById('dialog-btn-ok').click();`);
        for (let i = 0; i < 60; i++) { if (!(await ev(`return appState.isScanning;`))) break; await sleep(500); }
        await sleep(800);

        // ④ スケールを決める（ものさしの左端 → 右端）。指で拡大した状態で撮る。
        await ev(`appState.viewState.scale = 2.6; await new Promise(r=>setTimeout(r,100));`);
        await centerOn(20, 930);          // ものさしの左端に十字を合わせた状態
        await markCrosshair(70);
        await shotAroundCrosshair('04b_scale_start.png', -80, -150, 380, 210);
        await markOff();
        await ev(`window.confirmAtCrosshair(); await new Promise(r=>setTimeout(r,400));`);
        await centerOn(520, 930);         // 右端へ動かすと両矢印が付いてくる
        await markCrosshair(70);
        await shotAroundCrosshair('04d_scale_arrow.png', -300, -150, 380, 210);
        await markOff();
        await ev(`
            const s=appState;
            s.calibration.scaleStart={x:20,y:930}; s.calibration.scaleEnd={x:520,y:930};
            s.calibration.scaleActual=100; s.calibration.scaleRatio=0.2; s.scaleSkipped=false;
            document.getElementById('info-scale').textContent='0.200 cm/px';
            window.setPendingCapture(null); window.updateScaleBanner(); window.updateStepGuide();
            appState.viewState.scale=1; appState.viewState.offsetX=0; appState.viewState.offsetY=0;
            window.drawVideoFrame();
            await new Promise(r=>setTimeout(r,300));`);

        // ⑤ 点を打つ（球に十字を合わせた状態）
        const shotFrame = 45;                       // 落ち始めから 0.35 秒後あたり
        const tBall = (shotFrame - 24) / 60;
        const yBall = 80 + 0.5 * 9.8 * tBall * tBall * 500;   // gen_samples.py と同じ式
        await ev(`window.seekToFrame(${shotFrame}); await new Promise(r=>setTimeout(r,500));`);
        await centerOn(270, Math.round(yBall));
        await markCrosshair(92);
        await shot('05_track.png', ['.canvas-container'], 6);
        await markOff();
        await markOn(['#btn-confirm']);
        await shot('05b_confirm.png', ['.action-bar'], 14);
        await markOff();

        // 打点を作ってグラフを出す
        await ev(`
            const s=appState, v=s.videoElement;
            const cv=document.createElement('canvas'); cv.width=540; cv.height=960;
            const cx=cv.getContext('2d',{willReadFrequently:true});
            const seek=(k)=>new Promise(r=>{let d=false;
                const h=()=>{if(d)return;d=true;v.removeEventListener('seeked',h);r();};
                v.addEventListener('seeked',h); window.seekToFrame(k);
                setTimeout(()=>{if(!d){d=true;v.removeEventListener('seeked',h);r();}},2000);});
            s.trackingData=[]; s.activeObjectId=1;
            for(let k=s.rangeIn;k<=s.rangeOut;k++){
                await seek(k); await new Promise(r=>setTimeout(r,25));
                cx.drawImage(v,0,0,540,960);
                const d=cx.getImageData(0,0,540,960).data; let sx=0,sy=0,c=0;
                for(let i=0;i<d.length;i+=4){ if(d[i]>190&&d[i+1]>120&&d[i+2]<110){
                    const p=i/4; sx+=p%540; sy+=Math.floor(p/540); c++; } }
                if(c>0) s.trackingData.push({id:7000+k,frame:k,time:window.frameTimeOf(k),x:sx/c,y:sy/c,objectId:1});
            }
            window.updateDataTable(); window.updateGraph(); window.drawVideoFrame();
            await new Promise(r=>setTimeout(r,400));
            return s.trackingData.length;`);
        await ev(`appState.viewState.scale=1;appState.viewState.offsetX=0;appState.viewState.offsetY=0;window.drawVideoFrame();`);
        await shot('06_graph.png', ['#graph-stack'], 8);

        // ⑥ 傾きの区間
        await ev(`document.getElementById('btn-submit').click(); await new Promise(r=>setTimeout(r,900));`);
        await ev(`document.getElementById('btn-slope-range').click(); await new Promise(r=>setTimeout(r,700));
            const cv=document.getElementById('ggd-canvas'); const r=cv.getBoundingClientRect();
            const send=(t,x)=>cv.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:r.top+r.height/2,bubbles:true,pointerId:1}));
            send('pointerdown',r.left+r.width*0.2); send('pointermove',r.left+r.width*0.85); send('pointerup',r.left+r.width*0.85);
            await new Promise(r2=>setTimeout(r2,400));`);
        await markOn(['#ggd-readout']);
        await shot('08_slope.png', ['#dialog-overlay .dialog'], 0);
        await markOff();
        await ev(`document.getElementById('dialog-btn-ok').click(); await new Promise(r=>setTimeout(r,2500));`);

        // ⑦ 保存
        for (let i = 0; i < 60; i++) { if (await ev(`return !document.getElementById('strobe-final').hidden;`)) break; await sleep(500); }
        await markOn(['#btn-slope-range', '#btn-strobe-save']);
        await shot('09c_save_controls.png', ['.submit-slope', '.submit-actions'], 20);
        await markOff();
    } catch (e) { console.error('❌ ' + e.message); process.exitCode = 1; }
    finally { try { ws && ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {}
        try { srv.close(); } catch (e) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} }
    // 画像を軽くする（1枚あたり数十KBに。文字がつぶれない範囲の減色）
    try {
        const { execFileSync } = require('child_process');
        for (const f of fs.readdirSync(OUT).filter(n => n.endsWith('.png'))) {
            const fp = path.join(OUT, f);
            try { execFileSync('pngquant', ['--quality', '70-92', '--speed', '1', '--strip',
                                            '--force', '--output', fp, fp]); } catch (e) { /* 非0終了は無視 */ }
        }
        const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
        console.log(`  圧縮後の合計: ${(total / 1024).toFixed(0)}KB`);
    } catch (e) { console.warn('  pngquant が無いので圧縮を省略しました'); }
    console.log(`\n${made} 枚を ${path.relative(ROOT, OUT)}/ に保存しました`);
})();
