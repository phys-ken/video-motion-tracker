// Physics Tracker - tests/trim.test.js
// 「使う範囲を決める」ダイアログの検証。自由落下サンプルには前後に静止区間が
// あるので、それを実際に切って、表示と状態が食い違わないことを確かめる。
//   実行:  node tests/trim.test.js       任意: SHOTS=/path/to/dir でスクショ保存
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const SHOTS = process.env.SHOTS || null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.error('  ❌ ' + m); } };
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
  send(method, params = {}, sessionId) { const id = ++this.id; const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.p.set(id, { resolve, reject }); this.ws.send(JSON.stringify(msg)); }); } }
async function ev(cdp, S, body) {
    const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) { const x = r.exceptionDetails.exception; throw new Error('ページ内例外: ' + ((x && (x.description || x.value)) || '')); }
    return r.result.value;
}

(async () => {
console.log('=== 使う範囲を決めるダイアログ 検証 開始 ===');
const srv = await startServer(); const base = `http://127.0.0.1:${srv.address().port}`;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-trim-'));
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
    '--no-first-run', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let ws;
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
    const shot = async n => { if (!SHOTS) return; const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
        fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64')); };

    await cdp.send('Page.navigate', { url: base + '/' }, S); await sleep(1500);
    await ev(cdp, S, `localStorage.clear();location.reload();`); await sleep(1500);
    // ダイアログは抑止せずに、生徒と同じ経路でサンプルを読む
    await ev(cdp, S, `document.querySelector('[data-mode="free-fall"]').click();window.closeModePanel();
        await window.loadSampleByUrl('samples/free_fall.mp4','free_fall.mp4');`);
    for (let i = 0; i < 120; i++) { if (await ev(cdp, S, `return !appState.isScanning && appState.totalFrames>0;`)) break; await sleep(250); }
    await sleep(600);

    const shown = await ev(cdp, S, `
        const ov=document.getElementById('dialog-overlay');
        return {shown:getComputedStyle(ov).display!=='none',
                title:document.getElementById('dialog-title').textContent,
                info:document.querySelector('.trim-info').textContent.trim(),
                frame:document.getElementById('trim-frame-lbl').textContent.trim(),
                range:document.getElementById('trim-range-lbl').textContent.trim(),
                resetHidden:document.getElementById('trim-reset').hidden,
                ok:document.getElementById('dialog-btn-ok').textContent.trim(),
                total:appState.totalFrames};`);
    ok(shown.shown, '読み込み直後にダイアログが出る');
    ok(shown.title === '使う範囲を決める', `見出しが「次に何をするか」になっている (${shown.title})`);
    // 同じ画面の中で数え方が食い違わないこと（以前は「80コマ」と「コマ 0 / 79」が同居していた）
    const totalShown = shown.total + 1;
    ok(shown.info.startsWith(`${totalShown} コマ`), `総コマ数の表示 (${shown.info})`);
    ok(shown.frame === `コマ 1 / ${totalShown}`, `現在コマも同じ数え方（1始まり） (${shown.frame})`);
    ok(/全部の \d+ コマを使います/.test(shown.range), `未カットの状態が文で分かる (${shown.range})`);
    ok(shown.resetHidden, '未カットなら「全部に戻す」は出ない');
    ok(shown.ok === 'はじめる', 'ボタンは「はじめる」だけ');
    // 手順ガイドの右端（スケール未設定の警告チップ）が画面からはみ出さないこと
    const guide = await ev(cdp, S, `
        const g=document.querySelector('.step-guide')||document.getElementById('step-guide');
        const chip=document.getElementById('scale-warn-chip');
        const cb=chip?chip.getBoundingClientRect():null;
        return {hScroll:document.documentElement.scrollWidth>innerWidth+1,
                chipShown:!!chip&&!chip.hidden,
                chipRight:cb?Math.round(cb.right):0, w:innerWidth,
                guideRight:g?Math.round(g.getBoundingClientRect().right):0};`);
    ok(!guide.hScroll, 'ページが横スクロールしない');
    ok(!guide.chipShown || guide.chipRight <= guide.w + 1,
        `スケール未設定の警告が画面内に収まる (右端 ${guide.chipRight} / 幅 ${guide.w})`);
    await shot('trim_1_open.png');

    // 指で押す部分の大きさ（Apple HIG 44px / Material 48px を下回らない）
    const hit = await ev(cdp, S, `
        const r=(id)=>{const b=document.getElementById(id).getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)];};
        const sl=document.getElementById('trim-slider').getBoundingClientRect();
        const dlg=document.querySelector('.dialog').getBoundingClientRect();
        return {p10:r('trim-prev-10'),p1:r('trim-prev-1'),n1:r('trim-next-1'),n10:r('trim-next-10'),
                setIn:r('trim-set-in'),setOut:r('trim-set-out'),
                sliderW:Math.round(sl.width), dlgW:Math.round(dlg.width),
                total:appState.totalFrames};`);
    const big = a => a[0] >= 44 && a[1] >= 44;
    ok(big(hit.p10) && big(hit.p1) && big(hit.n1) && big(hit.n10),
        `コマ送りが4つとも44px以上 (${hit.p10.join('x')})`);
    ok(big(hit.setIn) && big(hit.setOut), `ここから使う／ここまで使うが44px以上 (${hit.setIn.join('x')})`);
    // ボタンの名前と記号。|< >| は「最初/最後へ移動」の記号で、押しても移動しない
    // このボタンに使うと嘘になる（調べた製品にも転用例がなかった）
    const labels = await ev(cdp, S, `
        // アイコンは <span> の中の合字なので、テキストだけを取り出す
        const t=(id)=>{const e=document.getElementById(id).cloneNode(true);
            e.querySelectorAll('.material-icons-round').forEach(x=>x.remove());
            return e.textContent.trim();};
        const ic=(id)=>document.getElementById(id).querySelector('.material-icons-round').textContent.trim();
        const bi=document.getElementById('btn-range-in'), bo=document.getElementById('btn-range-out');
        return {inT:t('trim-set-in'), outT:t('trim-set-out'), inI:ic('trim-set-in'), outI:ic('trim-set-out'),
                barI:bi.querySelector('.material-icons-round').textContent.trim(),
                barO:bo.querySelector('.material-icons-round').textContent.trim(),
                barTitle:bi.title, guide:document.querySelector('.trim-guide').textContent};`);
    ok(labels.inT === 'ここから使う' && labels.outT === 'ここまで使う',
        `ボタン名が動作を言っている (${labels.inT} / ${labels.outT})`);
    ok(!/first_page|last_page/.test(labels.inI + labels.outI + labels.barI + labels.barO),
        '移動を意味する記号（|< >|）を設定ボタンに使っていない');
    ok(/ここから使う/.test(labels.barTitle), `画面下のボタンも同じ呼び名 (${labels.barTitle.slice(0, 12)}…)`);
    ok(!/切/.test(labels.guide), `説明文も「使う」で揃っている (${labels.guide.trim().slice(0, 24)}…)`);
    // スライダは横いっぱい。1コマ2pxでは指で狙えないので、粗い位置決めだけを担わせる
    ok(hit.sliderW > hit.dlgW * 0.8, `スライダが横いっぱいにある (${hit.sliderW}px / ダイアログ ${hit.dlgW}px)`);

    // コマ送りは1コマ・10コマとも効き、範囲の外にも動ける
    const jog = await ev(cdp, S, `
        window.seekToFrame(40); await new Promise(r=>setTimeout(r,400));
        const hit=(id)=>{document.getElementById(id).click();};
        hit('trim-next-1'); await new Promise(r=>setTimeout(r,350)); const a=appState.currentFrame;
        hit('trim-next-10'); await new Promise(r=>setTimeout(r,450)); const b=appState.currentFrame;
        hit('trim-prev-10'); await new Promise(r=>setTimeout(r,450)); const c=appState.currentFrame;
        hit('trim-prev-1'); await new Promise(r=>setTimeout(r,350)); const d=appState.currentFrame;
        return {a,b,c,d,lbl:document.getElementById('trim-frame-lbl').textContent.trim()};`);
    ok(jog.a === 41 && jog.b === 51 && jog.c === 41 && jog.d === 40,
        `1コマ・10コマのコマ送りが効く (40→${jog.a}→${jog.b}→${jog.c}→${jog.d})`);
    ok(jog.lbl === 'コマ 41 / ' + (hit.total + 1), `コマ表示が追随する (${jog.lbl})`);

    // 前の静止区間を切る → 帯・文言・「全部に戻す」が連動する
    const cut = await ev(cdp, S, `
        window.seekToFrame(24); await new Promise(r=>setTimeout(r,400));
        document.getElementById('trim-set-in').click(); await new Promise(r=>setTimeout(r,200));
        window.seekToFrame(58); await new Promise(r=>setTimeout(r,400));
        document.getElementById('trim-set-out').click(); await new Promise(r=>setTimeout(r,200));
        const sl=document.getElementById('trim-slider');
        return {rangeIn:appState.rangeIn,rangeOut:appState.rangeOut,
                text:document.getElementById('trim-range-lbl').textContent.trim(),
                band:sl.style.background.includes('linear-gradient'),
                marked:document.getElementById('trim-range-lbl').className.includes('is-trimmed'),
                resetHidden:document.getElementById('trim-reset').hidden};`);
    ok(cut.rangeIn === 24 && cut.rangeOut === 58, `前後を切れる (${cut.rangeIn}–${cut.rangeOut})`);
    ok(cut.text === 'コマ 25 〜 59 の 35 コマを使います', `残るコマ数が文で出る (${cut.text})`);
    ok(cut.band, 'スライダに「使う範囲」の帯が出る');
    ok(cut.marked && !cut.resetHidden, '切った状態が色で分かり、「全部に戻す」が出る');
    await shot('trim_2_cut.png');

    // 範囲を決めたあとでも、その外へコマ送りできる（切りすぎても戻せる）
    const outside = await ev(cdp, S, `
        window.seekToFrame(30); await new Promise(r=>setTimeout(r,400));
        document.getElementById('trim-prev-10').click(); await new Promise(r=>setTimeout(r,500));
        return {frame:appState.currentFrame, rangeIn:appState.rangeIn};`);
    ok(outside.frame === 20 && outside.rangeIn === 24,
        `切った範囲の外にもコマ送りできる (コマ${outside.frame} / 範囲の開始は${outside.rangeIn}のまま)`);

    // 全部に戻す
    const reset = await ev(cdp, S, `
        document.getElementById('trim-reset').click(); await new Promise(r=>setTimeout(r,200));
        return {rangeIn:appState.rangeIn,rangeOut:appState.rangeOut,
                text:document.getElementById('trim-range-lbl').textContent.trim(),
                resetHidden:document.getElementById('trim-reset').hidden,
                band:document.getElementById('trim-slider').style.background};`);
    ok(reset.rangeIn === 0 && reset.rangeOut === reset.rangeOut && reset.resetHidden && !reset.band,
        `「全部に戻す」で元通りになる (${reset.text})`);

    // はじめる → 範囲の先頭に頭出しされ、画面の常設カウンタも同じ数え方
    const started = await ev(cdp, S, `
        window.seekToFrame(24); await new Promise(r=>setTimeout(r,300));
        document.getElementById('trim-set-in').click(); await new Promise(r=>setTimeout(r,200));
        document.getElementById('dialog-btn-ok').click(); await new Promise(r=>setTimeout(r,900));
        return {closed:getComputedStyle(document.getElementById('dialog-overlay')).display==='none',
                frame:appState.currentFrame,
                counter:document.getElementById('frame-counter').textContent.trim()};`);
    ok(started.closed, '「はじめる」で閉じる');
    ok(started.frame === 24, '使う範囲の先頭に頭出しされる');
    ok(started.counter === `25 / ${totalShown}`, `常設カウンタもダイアログと同じ数え方 (${started.counter})`);
    // 範囲を決めた直後に走る複製確認が、アプリ自身のシークと競合して実コマを
    // 消してしまわないこと（2026-09 に22コマ消えた。走査中はシークを保留する）
    for (let i = 0; i < 120; i++) { if (!(await ev(cdp, S, `return appState.isScanning;`))) break; await sleep(500); }
    await sleep(400);
    const kept = await ev(cdp, S, `
        return {total:appState.totalFrames, times:appState.frameTimes.length,
                scanning:appState.isScanning, frame:appState.currentFrame};`);
    ok(!kept.scanning, '複製確認の走査が終わっている');
    ok(kept.times === shown.total + 1, `範囲を決めても実コマが消えない (${kept.times} コマのまま)`);
    await shot('trim_3_after.png');

    // 原点の十字は映像に描かない（自由落下の出だしで打点に重なって邪魔になるため）
    const originMark = await ev(cdp, S, `
        const s=appState;s.calibration.scaleRatio=0.2;s.activeObjectId=1;
        s.trackingData=[{id:1,frame:s.rangeIn,time:window.frameTimeOf(s.rangeIn),x:270,y:120,objectId:1}];
        window.drawVideoFrame(); await new Promise(r=>setTimeout(r,150));
        const c=s.canvas, ctx=c.getContext('2d');
        const p=window.videoToCanvas ? window.videoToCanvas(270,120) : null;
        // 打点の左右40px付近に、校正色(#FFC400)の腕が引かれていないことを見る
        let amber=0;
        for (const dx of [-38,-30,-24,24,30,38]) {
          const x=Math.round(p.x+dx), y=Math.round(p.y);
          if (x<0||y<0||x>=c.width||y>=c.height) continue;
          const d=ctx.getImageData(x,y,1,1).data;
          if (d[0]>230 && d[1]>170 && d[1]<215 && d[2]<80) amber++;
        }
        return {amber, has原点: (document.body.innerHTML.indexOf('原点')>=0)};`);
    ok(originMark.amber === 0, '最初の打点に原点の十字を描かない');
    await shot('trim_4_origin.png');
} catch (e) { fail++; console.error('❌ 実行エラー: ' + e.message); }
finally { try { ws && ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} }
console.log(`\n=== 使う範囲を決める 終了: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
})();
