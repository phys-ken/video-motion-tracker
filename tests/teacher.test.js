// Physics Tracker - tests/teacher.test.js
// 教員用照合ページ（teacher/）の検証: 実際にアプリでPNGを作り、そのファイルを
// 照合ページに読ませて「重複」「単独」「読めない」を正しく出せるか見る。
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..');
const CHROME=process.env.CHROME_BIN||'google-chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.svg':'image/svg+xml','.png':'image/png'};
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++;console.log('  ✅ '+m);}else{fail++;console.error('  ❌ '+m);}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function srvStart(){return new Promise(res=>{const s=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const fp=path.join(ROOT,p);if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){r.writeHead(404);r.end('nf');return;}r.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Cache-Control':'no-cache'});r.end(fs.readFileSync(fp));});s.listen(0,'127.0.0.1',()=>res(s));});}
const httpGet=u=>new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
class CDP{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
 send(method,params={},sessionId){const id=++this.id;const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify(msg));});}}
async function ev(cdp,S,body){const r=await cdp.send('Runtime.evaluate',{expression:`(async()=>{${body}})()`,awaitPromise:true,returnByValue:true},S);if(r.exceptionDetails){const x=r.exceptionDetails.exception;throw new Error('例外: '+((x&&(x.description||x.value))||''));}return r.result.value;}
(async()=>{
console.log('=== 教員用 照合ページ 検証 開始 ===');
const srv=await srvStart();const base=`http://127.0.0.1:${srv.address().port}`;
const udd=fs.mkdtempSync(path.join(os.tmpdir(),'tracker-teacher-'));
const proc=spawn(CHROME,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${udd}`,'--no-first-run','--disable-gpu','--mute-audio','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
let ws;const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pngs-'));
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
 // --- アプリ側で本物のPNGを2つ作る（同じ打点＝同じコード、別の打点＝別コード）---
 await cdp.send('Page.navigate',{url:base+'/'},S);await sleep(1200);
 await ev(cdp,S,`localStorage.clear();window.__suppressModePanel=true;window.__suppressTrimDialog=true;location.reload();`);
 await sleep(1500);
 await ev(cdp,S,`window.setMotionMode('free-fall');await window.loadSampleByUrl('samples/free_fall.mp4','free_fall.mp4');`);
 for(let i=0;i<80;i++){if(await ev(cdp,S,`return !appState.isScanning&&appState.totalFrames>0;`))break;await sleep(250);}
 const make=async(shift)=>ev(cdp,S,`
   const s=appState;s.activeObjectId=1;s.calibration.scaleRatio=0.2;
   s.trackingData=[];for(let k=0;k<12;k++)s.trackingData.push({id:k,frame:k,time:window.frameTimeOf(k),x:100+${shift},y:100+5*k*k,objectId:1});
   const verify=await window.computeVerificationCode();
   const cv=document.createElement('canvas');cv.width=40;cv.height=30;
   const blob=await new Promise(r=>cv.toBlob(r,'image/png'));
   const tagged=await window.pngWithMetadata(blob,{'tracker-code':verify.code,'tracker-hash':verify.hex,
     'tracker-mode':'自由落下・投げおろし','tracker-points':'12','tracker-video':'free_fall.mp4',
     'tracker-version':window.APP_VERSION,'Software':'動画解析トラッカー'});
   const buf=new Uint8Array(await tagged.arrayBuffer());
   return {code:verify.code,b64:btoa(String.fromCharCode(...buf))};`);
 const A=await make(0), A2=await make(0), B=await make(7);
 ok(A.code===A2.code,`同じ打点なら同じコード (${A.code})`);
 ok(A.code!==B.code,`違う打点なら違うコード (${B.code})`);
 fs.writeFileSync(path.join(tmp,'sato.png'),Buffer.from(A.b64,'base64'));
 fs.writeFileSync(path.join(tmp,'suzuki.png'),Buffer.from(A2.b64,'base64'));
 fs.writeFileSync(path.join(tmp,'tanaka.png'),Buffer.from(B.b64,'base64'));
 // スクショ相当（メタデータ無し）のPNG
 const plain=await ev(cdp,S,`const cv=document.createElement('canvas');cv.width=40;cv.height=30;
   const blob=await new Promise(r=>cv.toBlob(r,'image/png'));
   const buf=new Uint8Array(await blob.arrayBuffer());return btoa(String.fromCharCode(...buf));`);
 fs.writeFileSync(path.join(tmp,'screenshot.png'),Buffer.from(plain,'base64'));
 // --- 照合ページに読ませる ---
 await cdp.send('Page.navigate',{url:base+'/teacher/index.html'},S);await sleep(900);
 // ファイル入力に実ファイルを流し込む（objectId 経由なら DOM の id 失効を避けられる）
 await cdp.send('DOM.enable',{},S);
 const ro=await cdp.send('Runtime.evaluate',{expression:"document.getElementById('file')",includeCommandLineAPI:false},S);
 const oid=ro.result&&ro.result.objectId;
 if(oid){await cdp.send('DOM.setFileInputFiles',{objectId:oid,
   files:['sato.png','suzuki.png','tanaka.png','screenshot.png'].map(f=>path.join(tmp,f))},S);}
 else{const{root}=await cdp.send('DOM.getDocument',{},S);
   const q=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#file'},S);
   await cdp.send('DOM.setFileInputFiles',{nodeId:q.nodeId,
     files:['sato.png','suzuki.png','tanaka.png','screenshot.png'].map(f=>path.join(tmp,f))},S);}
 await sleep(700);
 const res=await ev(cdp,S,`
   const rows=[...document.querySelectorAll('#tb tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
   return {n:rows.length,rows,sum:document.getElementById('sum').textContent,
           hit:document.getElementById('sum').className.includes('hit'),
           tableShown:!document.getElementById('tbl').hidden};`);
 ok(res.n===4&&res.tableShown,`4件を表に出す`);
 const dupRows=res.rows.filter(r=>/重複/.test(r[6]));
 ok(dupRows.length===2&&dupRows.every(r=>r[1]===A.code),`使い回しの2件を重複として検出 (${A.code})`);
 ok(res.rows.some(r=>r[1]===B.code&&/単独/.test(r[6])),'別の打点の提出は単独と出る');
 ok(res.rows.some(r=>/読めない/.test(r[6])),'メタデータのない画像は「読めない」と出る');
 ok(res.hit&&/同じコードの提出が 1 組/.test(res.sum),`要約が重複を知らせる`);
 ok(res.rows.some(r=>r[2]==='自由落下・投げおろし'&&r[3]==='12'),'運動の種類と打点数も読めている');
}catch(e){fail++;console.error('❌ 実行エラー: '+e.message);}
finally{try{ws&&ws.close();}catch(e){}try{proc.kill();}catch(e){}try{srv.close();}catch(e){}
 try{fs.rmSync(udd,{recursive:true,force:true});fs.rmSync(tmp,{recursive:true,force:true});}catch(e){}}
console.log(`\n=== 照合ページ 終了: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail===0?0:1);})();
