// 配布用PDFを作る（manual/manual.pdf）
//   実行:  CHROME_BIN=/usr/bin/google-chrome node tools/gen_manual_pdf.js
// 画面写真を撮り直したら（npm run shots）、こちらも流し直すこと。
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'manual', 'manual.pdf');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
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
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'manualpdf-'));
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
        '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, S);
        await cdp.send('Page.navigate', { url: base + '/manual/index.html' }, S);
        await sleep(1800);
        await cdp.send('Runtime.evaluate', { expression:
            `(async()=>{ await document.fonts.ready;
               await Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r;}))); })()`,
            awaitPromise: true }, S);
        const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, S);
        fs.writeFileSync(OUT, Buffer.from(pdf.data, 'base64'));
        const buf = fs.readFileSync(OUT);
        const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
        console.log(`${path.relative(ROOT, OUT)}  ${(buf.length / 1024).toFixed(0)}KB  ${pages}ページ`);
    } catch (e) { console.error('❌ ' + e.message); process.exitCode = 1; }
    finally { try { ws && ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {}
        try { srv.close(); } catch (e) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} }
})();
