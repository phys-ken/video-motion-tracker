// Physics Tracker - tests/pointer.test.js
// マウス／トラックパッドでの操作を検証する。
// 授業で「MacBook で映像がカーソルに追従して点が打てない」という報告があり、
// 原因は (1) 2本指スクロールが一律に拡大していたこと、(2)「離した」を取りこぼすと
// パンが解除されないことだった。両方が戻らないよう、ここで押さえる。
//   実行:  node tests/pointer.test.js
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
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
  send(method, params = {}, S) { const id = ++this.id; const msg = { id, method, params };
    if (S) msg.sessionId = S;
    return new Promise((rs, rj) => { this.p.set(id, { resolve: rs, reject: rj }); this.ws.send(JSON.stringify(msg)); }); } }

(async () => {
console.log('=== マウス／トラックパッド操作の検証 開始 ===');
const srv = await startServer(); const base = `http://127.0.0.1:${srv.address().port}`;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ptr-'));
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
    const ev = async body => {
        const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }, S);
        if (r.exceptionDetails) { const x = r.exceptionDetails.exception; throw new Error('ページ内例外: ' + ((x && (x.description || x.value)) || '')); }
        return r.result.value;
    };
    // MacBook 相当（タッチなし・マウス/トラックパッド）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, S);
    await cdp.send('Network.setUserAgentOverride', { userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        platform: 'MacIntel' }, S);
    await cdp.send('Page.navigate', { url: base + '/' }, S); await sleep(1500);
    await ev(`localStorage.clear();window.__suppressTrimDialog=true;location.reload();`); await sleep(1600);
    await ev(`window.__suppressTrimDialog=true;
        document.querySelector('[data-mode="free-fall"]').click(); window.closeModePanel();
        await window.loadSampleByUrl('samples/free_fall.mp4','free_fall.mp4');`);
    for (let i = 0; i < 120; i++) { if (await ev(`return !appState.isScanning && appState.totalFrames>0;`)) break; await sleep(250); }
    await sleep(600);

    const SETUP = `
        const cv=document.getElementById('tracker-canvas');
        const r=cv.getBoundingClientRect();
        const at=(dx,dy)=>({clientX:r.left+r.width/2+dx, clientY:r.top+r.height/2+dy});
        const fire=(type,dx,dy,extra)=>{const p=at(dx,dy);
          cv.dispatchEvent(new PointerEvent(type,Object.assign({pointerId:1,pointerType:'mouse',
            isPrimary:true,bubbles:true,cancelable:true,buttons:(type==='pointerup'?0:1)},p,extra||{})));};
        const view=()=>({x:Math.round(appState.viewState.offsetX),
                         y:Math.round(appState.viewState.offsetY),
                         s:+appState.viewState.scale.toFixed(2)});
        const wheelAt=(deltas,ctrl)=>{let prevented=0;
          for(const d of deltas){
            const e=new WheelEvent('wheel',{deltaY:d,ctrlKey:!!ctrl,deltaMode:0,
              clientX:r.left+r.width*0.35, clientY:r.top+r.height*0.35, bubbles:true, cancelable:true});
            cv.dispatchEvent(e); if(e.defaultPrevented) prevented++;
          } return prevented;};
        const reset=()=>{appState.viewState={scale:1,offsetX:0,offsetY:0};window.drawVideoFrame();};
    `;

    console.log('\n--- トラックパッドの2本指スクロール ---');
    // 授業での不具合: 軽く1回払っただけで倍率が下限(0.5)まで振り切れ、映像がカーソルへ寄っていた
    const scroll = await ev(SETUP + `
        reset();
        const prevented = wheelAt(Array.from({length:40},(_,i)=> (i<25?6:2)), false);
        return {v:view(), prevented};`);
    ok(scroll.v.s === 1 && scroll.v.x === 0, `2本指スクロールでは拡大しない（倍率 ${scroll.v.s}）`);
    ok(scroll.prevented === 0, 'ページのスクロールを止めない（生徒はページを送りたい）');

    console.log('\n--- マウスのホイール ---');
    const wheel = await ev(SETUP + `
        reset();
        const prevented = wheelAt([100,100,100], false);
        const three = view();
        reset();
        wheelAt([100], false);
        return {three, one:view(), prevented};`);
    ok(wheel.three.s < 1 && wheel.three.s > 0.55, `ホイール3ノッチで穏やかに縮む（倍率 ${wheel.three.s}）`);
    ok(wheel.one.s > wheel.three.s, `量に比例する（1ノッチ ${wheel.one.s} > 3ノッチ ${wheel.three.s}）`);
    ok(wheel.prevented === 3, 'ホイールでの拡大時はページを動かさない');

    console.log('\n--- トラックパッドのピンチ ---');
    const pinch = await ev(SETUP + `
        reset();
        wheelAt(Array.from({length:20},()=>-3), true);
        return view();`);
    ok(pinch.s > 1.2 && pinch.s < 3, `ピンチでは素直に拡大する（倍率 ${pinch.s}）`);

    console.log('\n--- ドラッグの取りこぼし ---');
    // 「離した」が Canvas に届かないまま、ボタンを押さずにカーソルを動かす
    const stale = await ev(SETUP + `
        reset();
        fire('pointerdown',0,0); fire('pointermove',40,0);
        const dragged = view();
        fire('pointermove',160,0,{buttons:0});
        fire('pointermove',260,40,{buttons:0});
        return {dragged, after:view()};`);
    ok(stale.dragged.x === 40, `押しながら動かすと映像が動く（${stale.dragged.x}px）`);
    ok(stale.after.x === stale.dragged.x && stale.after.y === stale.dragged.y,
        '離したあとはカーソルを動かしても映像が追従しない');

    // 「離した」が来ないまま、もう一度押したとき（1つのマウスが2本指と誤認されていた）
    const dup = await ev(SETUP + `
        reset();
        fire('pointerdown',0,0); fire('pointerdown',0,0);
        fire('pointermove',60,60);
        return view();`);
    ok(dup.x !== 0 && dup.s === 1, `二度押しのあとでもドラッグでき、勝手に拡大しない（${dup.x}px / 倍率 ${dup.s}）`);

    // Canvas の外で離しても、押しっぱなし扱いが残らない
    const outside = await ev(SETUP + `
        reset();
        fire('pointerdown',0,0); fire('pointermove',30,0);
        window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',bubbles:true,buttons:0}));
        const before = view();
        fire('pointermove',200,0,{buttons:1});
        return {before, after:view()};`);
    ok(outside.after.x === outside.before.x,
        '画面の外で離した場合も、以降のカーソル移動で映像が動かない');

    console.log('\n--- 傾きの区間を選ぶ画面 ---');
    const slope = await ev(`
        const s=appState, v=s.videoElement;
        s.calibration.scaleRatio=0.2; s.rangeIn=24; s.rangeOut=58; s.activeObjectId=1;
        const cvv=document.createElement('canvas'); cvv.width=540; cvv.height=960;
        const cx=cvv.getContext('2d',{willReadFrequently:true});
        const seek=k=>new Promise(r=>{let d=false;const h=()=>{if(d)return;d=true;v.removeEventListener('seeked',h);r();};
          v.addEventListener('seeked',h);window.seekToFrame(k);setTimeout(()=>{if(!d){d=true;v.removeEventListener('seeked',h);r();}},2000);});
        s.trackingData=[];
        for(let k=24;k<=58;k++){await seek(k);await new Promise(r=>setTimeout(r,20));
          cx.drawImage(v,0,0,540,960);const d=cx.getImageData(0,0,540,960).data;let sx=0,sy=0,c=0;
          for(let i=0;i<d.length;i+=4){if(d[i]>190&&d[i+1]>120&&d[i+2]<110){const p=i/4;sx+=p%540;sy+=Math.floor(p/540);c++;}}
          if(c>0)s.trackingData.push({id:9100+k,frame:k,time:window.frameTimeOf(k),x:sx/c,y:sy/c,objectId:1});}
        window.updateDataTable(); window.updateGraph();
        window.openGraphDialog('vy-t', {});
        await new Promise(r=>setTimeout(r,600));
        const g=document.getElementById('ggd-canvas'); const gr=g.getBoundingClientRect();
        const send=(t,x,extra)=>g.dispatchEvent(new PointerEvent(t,Object.assign(
          {pointerId:1,pointerType:'mouse',bubbles:true,cancelable:true,buttons:(t==='pointerup'?0:1),
           clientX:x,clientY:gr.top+gr.height/2},extra||{})));
        send('pointerdown',gr.left+gr.width*0.3);
        send('pointermove',gr.left+gr.width*0.6);
        const mid=document.getElementById('ggd-readout').textContent;
        // 「離した」が届かないまま、ボタンを押さずにカーソルを動かす
        send('pointermove',gr.left+gr.width*0.95,{buttons:0});
        const after=document.getElementById('ggd-readout').textContent;
        document.getElementById('dialog-btn-ok').click();
        await new Promise(r=>setTimeout(r,300));
        return {mid:mid.slice(0,40), after:after.slice(0,40), same: mid===after};`);
    ok(slope.same, '選んだ区間が、離したあとのカーソル移動で勝手に広がらない');
} catch (e) { fail++; console.error('❌ 実行エラー: ' + e.message); }
finally { try { ws && ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} }
console.log(`\n=== マウス／トラックパッド 終了: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
})();
