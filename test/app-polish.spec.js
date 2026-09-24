/* 다듬기 모드 통합 테스트 — node test/app-polish.spec.js <음성.wav> [앱루트]
   헤드리스 크로미움은 AAC 코덱이 없으므로 WAV 를 넣어야 한다. */
/* 다듬기 모드 통합 테스트 — 실제 음성 파일을 넣고 처리·재생·저장까지 */
const { chromium } = require("playwright");
const http=require("http"),fs=require("fs"),path=require("path"),os=require("os");
const ROOT=process.argv[3]?require("path").resolve(process.argv[3]):process.cwd(), SRC=process.argv[2];
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",".wasm":"application/wasm",".json":"application/json",".onnx":"application/octet-stream"};
const srv=http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split("?")[0]);if(u.endsWith("/"))u+="아나운서.html";
  const f=path.join(ROOT,u);fs.stat(f,(e,st)=>{if(e||!st.isFile()){r.writeHead(404);return r.end();}
  r.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"application/octet-stream","Content-Length":st.size,"Cache-Control":"no-store"});fs.createReadStream(f).pipe(r);});});
const out=[],ck=(n,ok,d)=>out.push({n,ok:!!ok,d:d===undefined?"":String(d)});
(async()=>{
  await new Promise(r=>srv.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${srv.address().port}/`;
  const b=await chromium.launch({args:["--autoplay-policy=no-user-gesture-required"]});
  const ctx=await b.newContext({acceptDownloads:true});
  await ctx.addInitScript(()=>{
    const v=[{name:"KO",lang:"ko-KR",voiceURI:"a",localService:true,default:true}];
    Object.defineProperty(window,"speechSynthesis",{value:{paused:false,getVoices:()=>v,onvoiceschanged:null,speak(u){setTimeout(()=>{u.onstart&&u.onstart({});u.onend&&u.onend({});},5);},cancel(){},pause(){},resume(){}},configurable:true});
    window.SpeechSynthesisUtterance=function(t){this.text=t;this.rate=1;this.pitch=1;this.volume=1;};
  });
  const p=await ctx.newPage();
  const errs=[]; p.on("pageerror",e=>errs.push("PAGEERR "+e.message));
  p.on("console",m=>{ if(m.type()==="error" && !/AudioContext|autoplay/i.test(m.text())) errs.push(m.text()); });
  await p.goto(base); await p.waitForTimeout(900);
  await p.evaluate(()=>localStorage.clear()); await p.reload(); await p.waitForTimeout(900);
  const sk=await p.$("#onbSkip"); if(sk){await sk.click();await p.waitForTimeout(250);}

  ck("모드 탭 4개", (await p.$$eval(".modebar button", e=>e.length))===4);
  await p.click("#modePolish"); await p.waitForTimeout(600);
  ck("다듬기 탭 전환", await p.evaluate(()=>!document.getElementById("panePolish").hidden));
  ck("파일 고르기 전엔 본문 숨김", await p.evaluate(()=>document.getElementById("polishBody").hidden));
  ck("프리셋 3개", (await p.$$eval("#polishPresets button", e=>e.length))===3,
     (await p.$$eval("#polishPresets button", e=>e.map(x=>x.textContent).join("/"))));
  ck("프리셋 radiogroup", await p.evaluate(()=>document.getElementById("polishPresets").getAttribute("role")==="radiogroup"));

  await p.setInputFiles("#polishFile", SRC);
  await p.waitForFunction(()=>!document.getElementById("polishBody").hidden, null, {timeout:60000});
  ck("파일 읽음", (await p.textContent("#polishDropText")).includes("초"), await p.textContent("#polishDropText"));
  ck("다듬기 버튼 활성", !(await p.evaluate(()=>document.getElementById("polishRun").disabled)));

  await p.click("#polishRun");
  await p.waitForFunction(()=>!document.getElementById("polishReport").hidden, null, {timeout:300000});
  ck("처리 완료·보고서 표시", true);
  const rows = await p.$$eval("#polishTable tr", rs=>rs.slice(1).map(r=>Array.from(r.children).map(c=>c.textContent.trim())));
  rows.forEach(r=>console.log("   ", r.join("  ")));
  const lufs = rows.find(r=>r[0].includes("라우드니스"));
  ck("라우드니스 -16 근처", Math.abs(parseFloat(lufs[2])+16)<1.2, lufs[2]);
  const tp = rows.find(r=>r[0].includes("트루피크"));
  ck("트루피크 -1 이하", parseFloat(tp[2])<=-0.5, tp[2]);
  const va = rows.find(r=>r[0].includes("편차"));
  ck("음량 편차 감소", parseFloat(va[2])<parseFloat(va[1]), va[1]+"→"+va[2]);
  ck("저장 버튼 활성", !(await p.evaluate(()=>document.getElementById("polishSave").disabled)));
  ck("다듬은 것 듣기 활성", !(await p.evaluate(()=>document.getElementById("polishB").disabled)));

  // 프리셋 바꾸면 이전 결과 무효화
  await p.click("#polishPresets button[data-k='warm']"); await p.waitForTimeout(300);
  ck("프리셋 변경 시 결과 무효화", await p.evaluate(()=>document.getElementById("polishReport").hidden && document.getElementById("polishSave").disabled));
  await p.click("#polishRun");
  await p.waitForFunction(()=>!document.getElementById("polishReport").hidden, null, {timeout:300000});
  ck("다른 프리셋으로 재처리", true);

  // 저장
  const dl = p.waitForEvent("download",{timeout:30000}).catch(()=>null);
  await p.click("#polishSave");
  const d = await dl;
  if(!d) ck("WAV 저장", false, "다운로드 없음");
  else {
    const tmp = path.join(os.tmpdir(),"polish-test.wav"); await d.saveAs(tmp);
    const buf=fs.readFileSync(tmp);
    ck("WAV 저장", buf.toString("ascii",0,4)==="RIFF" && buf.length>100000, d.suggestedFilename()+" "+buf.length+"B");
    ck("파일명에 프리셋", d.suggestedFilename().includes("warm"), d.suggestedFilename());
    let peak=0; const n=buf.readUInt32LE(40)/2;
    for(let i=0;i<n;i++){const v=Math.abs(buf.readInt16LE(44+i*2))/32768; if(v>peak)peak=v;}
    ck("저장본 클리핑 없음", peak<0.999 && peak>0.5, "peak "+peak.toFixed(3));
    fs.unlinkSync(tmp);
  }

  // 모드 나가면 재생 정지
  await p.click("#polishB"); await p.waitForTimeout(400);
  await p.click("#modeScript"); await p.waitForTimeout(400);
  ck("모드 나가면 재생 정지", await p.evaluate(()=>document.getElementById("polishStop").disabled));

  const bad=out.filter(c=>!c.ok);
  out.forEach(c=>console.log(`${c.ok?"  ok":"FAIL"}  ${c.n}${c.d?"  — "+c.d:""}`));
  console.log(`\nPASS ${out.length-bad.length} / FAIL ${bad.length}`);
  console.log("errors:", errs.length?errs.slice(0,5):"none");
  await b.close(); srv.close();
  process.exit(bad.length||errs.length?1:0);
})().catch(e=>{console.error("EXCEPTION",e.message); out.forEach(c=>console.log(`${c.ok?"  ok":"FAIL"}  ${c.n}`)); process.exit(1);});
