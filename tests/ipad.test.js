// Physics Tracker - tests/ipad.test.js
// iPad 相当の条件で通し検証（実Chrome + iPadのUA + タッチ/回転エミュレーション）
//   実行:  node tests/ipad.test.js       任意: SHOTS=/path/to/dir でスクショ保存
// Chrome は WebKit ではないので Safari 固有の不具合は再現しない。ここで見るのは
// 「タッチ・回転・縦動画・保存の手順」がコードとして正しく組めているかまで。
// 1) 縦動画 x 縦画面   2) 追跡途中の回転   3) 実タッチのピンチ/パン
// 4) 開けない動画の案内 5) 保存アンカーとObjectURLの寿命
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..');
const CHROME=process.env.CHROME_BIN||'google-chrome';
const SHOTS=process.env.SHOTS||null;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;console.log('  ✅ '+m);}else{fail++;console.error('  ❌ '+m);}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const IPAD_UA='Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
function startServer(){return new Promise(res=>{const s=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const fp=path.join(ROOT,p);if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){r.writeHead(404);r.end('nf');return;}r.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Cache-Control':'no-cache'});r.end(fs.readFileSync(fp));});s.listen(0,'127.0.0.1',()=>res(s));});}
const httpGet=u=>new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
class CDP{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
 send(method,params={},sessionId){const id=++this.id;const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify(msg));});}}
async function ev(cdp,S,body){const r=await cdp.send('Runtime.evaluate',{expression:`(async()=>{${body}})()`,awaitPromise:true,returnByValue:true},S);if(r.exceptionDetails){const x=r.exceptionDetails.exception;throw new Error('ページ内例外: '+((x&&(x.description||x.value))||''));}return r.result.value;}

(async()=>{
console.log('=== iPad 相当チェック 開始 ===');
const srv=await startServer();const base=`http://127.0.0.1:${srv.address().port}`;
const udd=fs.mkdtempSync(path.join(os.tmpdir(),'tracker-ipad-'));
const proc=spawn(CHROME,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${udd}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--mute-audio','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
let ws;
try{
 const pf=path.join(udd,'DevToolsActivePort');const t0=Date.now();
 while(!fs.existsSync(pf)){if(Date.now()-t0>12000)throw new Error('DevToolsActivePort 未生成');await sleep(100);}
 const port=parseInt(fs.readFileSync(pf,'utf8').split('\n')[0],10);
 const info=JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
 ws=new WebSocket(info.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});
 const cdp=new CDP(ws);
 const{targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
 const{sessionId:S}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
 await cdp.send('Page.enable',{},S);await cdp.send('Runtime.enable',{},S);
 await cdp.send('Network.setUserAgentOverride',{userAgent:IPAD_UA,platform:'iPad'},S);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},S);
 const shot=async n=>{if(!SHOTS)return;const r=await cdp.send('Page.captureScreenshot',{format:'png'},S);fs.mkdirSync(SHOTS,{recursive:true});fs.writeFileSync(path.join(SHOTS,n),Buffer.from(r.data,'base64'));};
 const metrics=(w,h)=>cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:true},S);
 const touch=(type,pts)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:pts},S);

 // ---------- 1) 縦画面 x 縦動画 ----------
 console.log('\n--- iPad 縦 (820x1180) / 縦動画 ---');
 await metrics(820,1180);
 await cdp.send('Page.navigate',{url:base+'/'},S);await sleep(1500);
 await ev(cdp,S,`localStorage.clear();location.reload();`);await sleep(1500);
 const uaSeen=await ev(cdp,S,`return {ua:navigator.userAgent.slice(0,20),touch:navigator.maxTouchPoints};`);
 ok(/iPad/.test(uaSeen.ua)&&uaSeen.touch>0,`iPadのUA・タッチとして認識 (maxTouchPoints=${uaSeen.touch})`);
 await ev(cdp,S,`document.querySelector('[data-mode="vertical-throw"]').click();window.closeModePanel();
   await window.loadSampleByUrl('samples/vertical_throw.mp4','vertical_throw.mp4');`);
 for(let i=0;i<100;i++){if(await ev(cdp,S,`return !appState.isScanning&&appState.totalFrames>0;`))break;await sleep(250);}
 await ev(cdp,S,`const b=document.getElementById('dialog-btn-ok');if(b&&document.getElementById('dialog-overlay').style.display==='flex')b.click();await new Promise(r=>setTimeout(r,400));`);
 await sleep(400);
 const portraitFit=await ev(cdp,S,`
   const c=document.getElementById('tracker-canvas'),r=c.getBoundingClientRect();
   const m=null;
   return {vw:appState.videoElement.videoWidth,vh:appState.videoElement.videoHeight,
     cw:Math.round(r.width),ch:Math.round(r.height),
     inView:r.top>=-1&&r.bottom<=innerHeight+1,
     noHScroll:document.documentElement.scrollWidth<=innerWidth+1};`);
 ok(portraitFit.vh>portraitFit.vw,`縦向きの動画 (${portraitFit.vw}x${portraitFit.vh})`);
 ok(portraitFit.inView&&portraitFit.noHScroll,`Canvasが画面内に収まり横スクロールしない (${portraitFit.cw}x${portraitFit.ch})`);
 await shot('ipad_1_portrait.png');

 // スケールを決めて追跡できる状態にし、実タッチで打点まで進める
 await ev(cdp,S,`
   const s=appState;s.calibration.scaleStart={x:20,y:930};s.calibration.scaleEnd={x:520,y:930};
   s.calibration.scaleActual=100;s.calibration.scaleRatio=0.2;s.scaleSkipped=false;
   document.getElementById('info-scale').textContent='0.200 cm/px';
   window.setPendingCapture(null);window.updateScaleBanner();window.updateStepGuide();
   window.__suppressTrimDialog=true;`);
 await sleep(200);

 // ---------- 2) 実タッチのパンとピンチ ----------
 console.log('\n--- 実タッチ（1本指パン / 2本指ピンチ） ---');
 const before=await ev(cdp,S,`return {ox:appState.viewState.offsetX,oy:appState.viewState.offsetY,sc:appState.viewState.scale};`);
 const cr=await ev(cdp,S,`const r=document.getElementById('tracker-canvas').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};`);
 await touch('touchStart',[{x:cr.x,y:cr.y,id:1}]);
 for(let i=1;i<=5;i++)await touch('touchMove',[{x:cr.x+i*8,y:cr.y+i*4,id:1}]);
 await touch('touchEnd',[]);
 await sleep(200);
 const afterPan=await ev(cdp,S,`return {ox:appState.viewState.offsetX,oy:appState.viewState.offsetY,pageScroll:window.scrollY};`);
 ok(Math.abs(afterPan.ox-before.ox)>10,`1本指ドラッグで映像がパンする (Δx=${(afterPan.ox-before.ox).toFixed(0)}px)`);
 ok(afterPan.pageScroll===0,'指のドラッグでページがスクロールしてしまわない');
 // 2本指ピンチ
 await touch('touchStart',[{x:cr.x-60,y:cr.y,id:1},{x:cr.x+60,y:cr.y,id:2}]);
 for(let i=1;i<=6;i++)await touch('touchMove',[{x:cr.x-60-i*10,y:cr.y,id:1},{x:cr.x+60+i*10,y:cr.y,id:2}]);
 await touch('touchEnd',[]);
 await sleep(200);
 const afterPinch=await ev(cdp,S,`return {sc:appState.viewState.scale,vv:(window.visualViewport?window.visualViewport.scale:1)};`);
 ok(afterPinch.sc>before.sc*1.1,`2本指ピンチで映像が拡大する (${before.sc.toFixed(2)}→${afterPinch.sc.toFixed(2)})`);
 ok(Math.abs(afterPinch.vv-1)<0.01,'ページ自体はズームしない（映像だけが拡大）');
 await shot('ipad_2_pinch.png');
 await ev(cdp,S,`appState.viewState.scale=1;appState.viewState.offsetX=0;appState.viewState.offsetY=0;window.drawVideoFrame&&window.drawVideoFrame();`);

 // 打点を作る（座標は明示的に投入し、回転前後で不変か見る）
 await ev(cdp,S,`
   const s=appState,v=s.videoElement;s.trackingData=[];s.activeObjectId=1;
   const cv=document.createElement('canvas');cv.width=540;cv.height=960;
   const cx=cv.getContext('2d',{willReadFrequently:true});
   const seek=k=>new Promise(r=>{let d=false;const h=()=>{if(d)return;d=true;v.removeEventListener('seeked',h);r();};
     v.addEventListener('seeked',h);window.seekToFrame(k);setTimeout(()=>{if(!d){d=true;v.removeEventListener('seeked',h);r();}},2000);});
   const N=Math.min(53,s.totalFrames);
   for(let k=0;k<=N;k+=2){await seek(k);await new Promise(r=>setTimeout(r,35));
     cx.drawImage(v,0,0,540,960);const d=cx.getImageData(0,0,540,960).data;let sx=0,sy=0,c=0;
     for(let i=0;i<d.length;i+=4){if(d[i]>140&&d[i+1]>140&&d[i+2]<110){sx+=(i/4)%540;sy+=Math.floor((i/4)/540);c++;}}
     if(c>0)s.trackingData.push({id:3000+k,frame:k,time:window.frameTimeOf(k),x:sx/c,y:sy/c,objectId:1});
   }
   window.updateDataTable();window.updateGraph();return s.trackingData.length;`);
 const phys0=await ev(cdp,S,`
   const rows=window.buildExportRows?window.buildExportRows():null;
   const d=[...appState.trackingData].sort((a,b)=>a.frame-b.frame);
   const o=window.originOf(d);const p=window.physCoordOf(d[d.length-1],o);
   return {n:d.length,lastY:+p.y.toFixed(3),lastT:+p.t.toFixed(4)};`);
 ok(phys0.n>15,`実映像から ${phys0.n} 点を記録`);

 // ---------- 3) 追跡途中の回転 ----------
 console.log('\n--- 追跡の途中で回転（縦→横→縦） ---');
 await metrics(1180,820);
 await ev(cdp,S,`window.dispatchEvent(new Event('resize'));await new Promise(r=>setTimeout(r,300));`);
 await sleep(500);
 const land=await ev(cdp,S,`
   const c=document.getElementById('tracker-canvas'),r=c.getBoundingClientRect();
   const bar=document.querySelector('.action-bar'),br=bar.getBoundingClientRect();
   const d=[...appState.trackingData].sort((a,b)=>a.frame-b.frame);
   const o=window.originOf(d);const p=window.physCoordOf(d[d.length-1],o);
   return {cw:Math.round(r.width),ch:Math.round(r.height),
     canvasMatchesCss:c.width===Math.round(r.width)&&c.height===Math.round(r.height),
     inView:r.top>=-1&&r.bottom<=innerHeight+1,
     noHScroll:document.documentElement.scrollWidth<=innerWidth+1,
     barVisible:br.bottom<=innerHeight+1&&br.width>0,
     n:d.length,lastY:+p.y.toFixed(3)};`);
 ok(land.canvasMatchesCss,`回転後にCanvasの解像度が表示サイズと一致 (${land.cw}x${land.ch})`);
 ok(land.inView&&land.noHScroll,'回転後も画面内に収まり横スクロールしない');
 ok(land.barVisible,'回転後も下部の操作バーが見えている');
 ok(land.n===phys0.n&&Math.abs(land.lastY-phys0.lastY)<0.001,`回転しても打点と物理座標が変わらない (${land.lastY} cm)`);
 await shot('ipad_3_landscape.png');
 await metrics(820,1180);
 await ev(cdp,S,`window.dispatchEvent(new Event('resize'));await new Promise(r=>setTimeout(r,300));`);
 await sleep(400);
 const back=await ev(cdp,S,`
   const c=document.getElementById('tracker-canvas'),r=c.getBoundingClientRect();
   const secs=[...document.querySelectorAll('.sidebar-section')].map(e=>e.getBoundingClientRect());
   let overlap=false;
   for(let i=0;i<secs.length;i++)for(let j=i+1;j<secs.length;j++){const a=secs[i],b=secs[j];
     if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)overlap=true;}
   return {canvasMatchesCss:c.width===Math.round(r.width)&&c.height===Math.round(r.height),
     noHScroll:document.documentElement.scrollWidth<=innerWidth+1,overlap,
     gap:Math.round(innerHeight-document.documentElement.getBoundingClientRect().height)};`);
 ok(back.canvasMatchesCss&&back.noHScroll,'縦に戻しても崩れない');
 ok(!back.overlap,'縦に戻してもパネルが重ならない');
 await shot('ipad_4_portrait_again.png');

 // ---------- 4) 提出画像の保存 ----------
 console.log('\n--- 提出画像の保存 ---');
 // 既定は「傾きを表示する」がオン。区間を決めるまで保存できないので、開く前に決めておく
 await ev(cdp,S,`appState.slopeRange={a:0.05,b:0.60};return true;`);
 await ev(cdp,S,`document.getElementById('btn-submit').click();await new Promise(r=>setTimeout(r,300));`);
 let ready=null;
 for(let i=0;i<60;i++){ready=await ev(cdp,S,`
   const img=document.getElementById('strobe-final'),st=document.getElementById('strobe-status');
   return {imgShown:!!img&&!img.hidden&&/^blob:/.test(img.getAttribute('src')||''),
           canvasHidden:document.getElementById('strobe-preview').hidden,
           note:!document.getElementById('strobe-longpress').hidden,
           status:st?st.textContent:''};`);
   if(ready&&ready.imgShown)break;await sleep(500);}
 ok(ready&&ready.imgShown,`タップ前に完成PNGができている (${ready&&ready.status})`);
 ok(ready&&ready.canvasHidden&&ready.note,'完成画像を表示し、長押し保存の案内を出す');
 // 縦長の動画でも、保存ボタンと傾きの設定が画面の中に見えていること
 const reach=await ev(cdp,S,`
   const b=document.getElementById('btn-strobe-save').getBoundingClientRect();
   const sl=document.getElementById('submit-slope').getBoundingClientRect();
   const img=document.getElementById('strobe-final').getBoundingClientRect();
   return {save:b.top>=0&&b.bottom<=innerHeight+1,slope:sl.bottom<=innerHeight+1,
           imgH:Math.round(img.height),vh:innerHeight};`);
 ok(reach.save&&reach.slope,`保存ボタンと傾きの設定が画面内にある（画像の高さ ${reach.imgH}px / 画面 ${reach.vh}px）`);
 const sync=await ev(cdp,S,`
   let seen=null,ticks=0;
   const origClick=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){seen={href:this.getAttribute('href'),dl:this.getAttribute('download'),inDom:document.body.contains(this),ticks};};
   const p=Promise.resolve().then(()=>{ticks++;});
   document.getElementById('btn-strobe-save').click();
   const immediate=!!seen;
   await p;
   HTMLAnchorElement.prototype.click=origClick;
   const alive=seen?await fetch(seen.href).then(r=>r.ok).catch(()=>false):false;
   return {immediate,seen,alive};`);
 ok(sync.immediate,'［保存］のタップと同じ処理の中でリンクが押される（iOSでジェスチャーが切れない）');
 ok(sync.seen&&/^report_[2-9A-HJ-NP-Z]{8}\.png$/.test(sync.seen.dl),`照合コード入りのファイル名で保存する (${sync.seen&&sync.seen.dl})`);
 ok(sync.seen&&sync.seen.inDom,'クリック時にリンクがDOMに入っている（iOSで必要）');
 ok(sync.alive,'クリック直後もObjectURLが生きている（早すぎるrevokeをしない）');
 const shared=await ev(cdp,S,`
   let got=null;const oc=navigator.canShare,os=navigator.share;
   navigator.canShare=()=>true;navigator.share=(d)=>{got=(d.files||[]).map(f=>f.name);return Promise.resolve();};
   document.getElementById('btn-strobe-save').click();
   navigator.canShare=oc;navigator.share=os;
   return got;`);
 ok(Array.isArray(shared)&&shared.length===1&&/\.png$/.test(shared[0]),`共有シートが使えるならそちらへ渡す (${shared&&shared[0]})`);
 await shot('ipad_4b_save.png');
 await ev(cdp,S,`document.getElementById('submit-close').click();await new Promise(r=>setTimeout(r,200));`);

 // ---------- 4b) 傾きの区間と端末判定 ----------
 console.log('\n--- 傾きの区間と端末判定 ---');
 // 区間が未設定だと保存できない（チェックは既定でオン）
 const gate=await ev(cdp,S,`
   appState.slopeRange=null;appState.showSlope=true;
   document.getElementById('btn-submit').click();
   await new Promise(r=>setTimeout(r,900));
   const st=document.getElementById('slope-state');
   return {disabled:document.getElementById('btn-strobe-save').disabled,
           rowShown:!document.getElementById('submit-slope').hidden,
           warn:st.className.includes('warn'),text:st.textContent};`);
 ok(gate.rowShown&&gate.disabled&&gate.warn,`区間未設定だと保存ボタンが押せない (${gate.text})`);
 // 区間を決めると保存できるようになり、画像の中に区間が印字される
 const set=await ev(cdp,S,`
   document.getElementById('btn-slope-range').click();
   await new Promise(r=>setTimeout(r,500));
   const dlgShown=getComputedStyle(document.getElementById('dialog-overlay')).display!=='none';
   const panelStill=getComputedStyle(document.getElementById('submit-overlay')).display!=='none';
   const cv=document.getElementById('ggd-canvas');
   const r=cv.getBoundingClientRect();
   const send=(type,x)=>cv.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:r.top+r.height/2,bubbles:true,pointerId:1}));
   send('pointerdown',r.left+r.width*0.35);send('pointermove',r.left+r.width*0.8);send('pointerup',r.left+r.width*0.8);
   await new Promise(r2=>setTimeout(r2,200));
   const readout=document.getElementById('ggd-readout').textContent;
   document.getElementById('dialog-btn-ok').click();
   await new Promise(r2=>setTimeout(r2,1500));
   return {dlgShown,panelStill,readout:readout.slice(0,60),
           range:appState.slopeRange,
           disabled:document.getElementById('btn-strobe-save').disabled,
           state:document.getElementById('slope-state').textContent};`);
 ok(set.dlgShown&&set.panelStill,'区間ダイアログは提出パネルの上に重なって開く（パネルは消えない）');
 ok(set.range&&set.range.b>set.range.a,`ドラッグで区間が決まる (${set.state})`);
 ok(!set.disabled,'区間を決めると保存できるようになる');
 // 傾きのチェックを外せば区間なしでも保存できる
 const off=await ev(cdp,S,`
   appState.slopeRange=null;
   const c=document.getElementById('slope-show');c.checked=false;
   c.dispatchEvent(new Event('change'));
   await new Promise(r=>setTimeout(r,1500));
   return {disabled:document.getElementById('btn-strobe-save').disabled,showSlope:appState.showSlope};`);
 ok(!off.disabled&&!off.showSlope,'傾きを出さない設定なら区間なしでも保存できる');
 // 端末判定: iPad は共有、Windows は直ダウンロード
 const os=await ev(cdp,S,`
   const f=window.isHandheldUA;
   const MAC='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
   const WIN='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
   const IPH='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1';
   const AND='Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
   return {ipad:f(MAC,5),mac:f(MAC,0),win:f(WIN,10),iphone:f(IPH,5),android:f(AND,5),
           here:window.isHandheld(),label:document.getElementById('save-label').textContent};`);
 ok(os.ipad===true&&os.mac===false,'同じUAでも iPad は共有・MacBook は直ダウンロードに分かれる');
 ok(os.win===false,'タッチ対応のWindows機でも直ダウンロードになる');
 ok(os.iphone===true&&os.android===true,'iPhone と Android は共有シート');
 ok(os.here===true&&/共有/.test(os.label),`いまの端末（iPad相当）では共有の文言になる (${os.label})`);
 await ev(cdp,S,`document.getElementById('submit-close').click();await new Promise(r=>setTimeout(r,200));`);

 // ---------- 5) 開けない動画の案内 ----------
 console.log('\n--- 開けない動画（HEVC相当） ---');
 const hevc=fs.existsSync(path.join(__dirname,'hevc_test.mp4'));
 const errDlg=await ev(cdp,S,`
   window.showVideoErrorDialog({code:4,message:"x"});
   const ov=document.getElementById('dialog-overlay');
   const t=document.getElementById('dialog-title'),b=document.getElementById('dialog-body');
   return {shown:ov&&ov.style.display==='flex',title:t?t.textContent:'',body:b?b.textContent.slice(0,120):''};`);
 if(errDlg.shown===undefined||errDlg.title===''){ok(false,'エラー案内をテストから呼べない');}
 else{
   ok(errDlg.shown,'開けない動画のときダイアログが出る');
   ok(/HEVC/.test(errDlg.body)&&/壊れ/.test(errDlg.body),`案内文がHEVCと破損の両方に触れている`);
 }
 await shot('ipad_5_error.png');
}catch(e){fail++;console.error('❌ 実行エラー: '+e.message);}
finally{try{ws&&ws.close();}catch(e){}try{proc.kill();}catch(e){}try{srv.close();}catch(e){}try{fs.rmSync(udd,{recursive:true,force:true});}catch(e){}}
console.log(`\n=== iPad 相当チェック 終了: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail===0?0:1);
})();
