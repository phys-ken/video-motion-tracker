// Physics Tracker - tests/manual.test.js
// 使い方ページ（manual/）の検証。画面写真は手で貼るので、リンク切れ・alt漏れ・
// 印刷崩れが起きやすい。3つの画面幅で読み込み、PDFにも書き出して確かめる。
//   実行:  node tests/manual.test.js     任意: SHOTS=/path/to/dir で保存
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..');
const CHROME=process.env.CHROME_BIN||'google-chrome';
const OUT=process.env.SHOTS||fs.mkdtempSync(path.join(os.tmpdir(),'manualout-'));
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.mp4':'video/mp4'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  ✅ '+m);} else {fail++;console.error('  ❌ '+m);} };
function srvStart(){return new Promise(res=>{const s=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const fp=path.join(ROOT,p);if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){r.writeHead(404);r.end('nf');return;}r.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Cache-Control':'no-cache'});r.end(fs.readFileSync(fp));});s.listen(0,'127.0.0.1',()=>res(s));});}
const httpGet=u=>new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
class CDP{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
 send(method,params={},S){const id=++this.id;const msg={id,method,params};if(S)msg.sessionId=S;return new Promise((rs,rj)=>{this.p.set(id,{resolve:rs,reject:rj});this.ws.send(JSON.stringify(msg));});}}
(async()=>{
const srv=await srvStart();const base=`http://127.0.0.1:${srv.address().port}`;
const udd=fs.mkdtempSync(path.join(os.tmpdir(),'ms-'));fs.mkdirSync(OUT,{recursive:true});
const proc=spawn(CHROME,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${udd}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'});
let ws;
try{
 const pf=path.join(udd,'DevToolsActivePort');const t0=Date.now();
 while(!fs.existsSync(pf)){if(Date.now()-t0>12000)throw new Error('port');await sleep(100);}
 const port=parseInt(fs.readFileSync(pf,'utf8').split('\n')[0],10);
 const info=JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
 ws=new WebSocket(info.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});
 const cdp=new CDP(ws);
 const{targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
 const{sessionId:S}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
 await cdp.send('Page.enable',{},S);await cdp.send('Runtime.enable',{},S);
 const ev=async b=>{const r=await cdp.send('Runtime.evaluate',{expression:`(async()=>{${b}})()`,awaitPromise:true,returnByValue:true},S);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails.exception));return r.result.value;};
 for (const [name,w,h] of [['ipad',820,1180],['phone',390,844],['pc',1280,900]]) {
   await cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<1000},S);
   await cdp.send('Page.navigate',{url:base+'/manual/index.html'},S);await sleep(1600);
   const chk=await ev(`
     await document.fonts.ready;
     const imgs=[...document.images];
     await Promise.all(imgs.map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r;})));
     const broken=imgs.filter(i=>!i.naturalWidth).map(i=>i.getAttribute('src'));
     const noAlt=imgs.filter(i=>!i.alt || !i.alt.trim()).length;
     return {n:imgs.length, broken, noAlt,
             hScroll: document.documentElement.scrollWidth > innerWidth+1,
             h: document.documentElement.scrollHeight};`);
   console.log(`\n--- ${name} (${w}px) ---`);
   ok(chk.n >= 10, `画面写真が ${chk.n} 枚そろっている`);
   ok(chk.broken.length === 0, `画像の貼り間違いがない${chk.broken.length?' — '+chk.broken.join(', '):''}`);
   ok(chk.noAlt === 0, 'すべての画像に説明（alt）が付いている');
   ok(!chk.hScroll, `横スクロールしない（高さ ${chk.h}px）`);
   const full=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},S);
   fs.writeFileSync(path.join(OUT,`manual_${name}.png`),Buffer.from(full.data,'base64'));
 }
 // 印刷（PDF）
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false},S);
 await cdp.send('Page.navigate',{url:base+'/manual/index.html'},S);await sleep(1600);
 const pdf=await cdp.send('Page.printToPDF',{printBackground:true,preferCSSPageSize:true},S);
 const pdfPath=path.join(OUT,'manual.pdf');
 fs.writeFileSync(pdfPath,Buffer.from(pdf.data,'base64'));
 const buf=fs.readFileSync(pdfPath);
 const pages=(buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)||[]).length;
 console.log('\n--- 印刷 / PDF ---');
 ok(buf.length>50000, `PDFに書き出せる（${(buf.length/1024).toFixed(0)}KB）`);
 ok(pages===1, `配布用PDFがA4 1枚に収まる（${pages}ページ）`);
 // 配布用PDFがリポジトリに置いてあり、いまのページと大きくずれていないこと
 const shipped=path.join(ROOT,'manual','manual.pdf');
 ok(fs.existsSync(shipped), '配布用PDF（manual/manual.pdf）が置いてある');
 if(fs.existsSync(shipped)){
   const sb=fs.readFileSync(shipped);
   const sp=(sb.toString('latin1').match(/\/Type\s*\/Page[^s]/g)||[]).length;
   ok(sp===pages, `配布用PDFのページ数が今のページと一致（${sp}ページ）`);
 }
}catch(e){fail++;console.error('❌ 実行エラー: '+e.message);}
finally{try{ws&&ws.close();}catch(e){}try{proc.kill();}catch(e){}try{srv.close();}catch(e){}
 try{fs.rmSync(udd,{recursive:true,force:true});}catch(e){}
 if(!process.env.SHOTS){try{fs.rmSync(OUT,{recursive:true,force:true});}catch(e){}}}
console.log(`\n=== 使い方ページ 終了: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail===0?0:1);
})();
