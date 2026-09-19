/* 앱 전체 신경망 경로 통합 테스트 — http 로 띄운 실제 앱에서
   AI 음성 켜기 → 모델 설치 → 목소리 섞기 → 낭독 → 긴 글 → 단어 → 중국어 폴백까지 확인한다.
   기본은 test/fixtures 의 대체 모델(models/supertonic-3 심볼릭 링크). 실가중치 검증은 CI 에서 한다.
   사용: node test/app-neural.spec.js [앱 루트]  */
// 앱을 http 로 띄우고 'AI 음성' 버튼 → 모델 설치 → 실제 낭독까지 통째로 확인한다 (대체 모델 사용)
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.argv[2] ? require("path").resolve(process.argv[2]) : process.cwd();
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript",
  ".wasm":"application/wasm", ".json":"application/json", ".onnx":"application/octet-stream", ".css":"text/css" };
const BLOCK_MODELS = process.argv.includes("--no-models");
const srv = http.createServer((req,res)=>{
  let u = decodeURIComponent(req.url.split("?")[0]); if (u.endsWith("/")) u += "아나운서.html";
  if (BLOCK_MODELS && u.includes("/models/")) { res.writeHead(404); return res.end(); }
  const f = path.join(ROOT, u);
  fs.stat(f,(e,st)=>{ if(e||!st.isFile()){res.writeHead(404);return res.end();}
    res.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"application/octet-stream","Content-Length":st.size,"Cache-Control":"no-store"});
    fs.createReadStream(f).pipe(res); });
});
const out=[], ck=(n,ok,d)=>out.push({n,ok:!!ok,d:d===undefined?"":String(d)});
(async()=>{
  await new Promise(r=>srv.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${srv.address().port}/`;
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:1280,height:900}});
  await ctx.addInitScript(()=>{
    const voices=[{name:"Local Basic",lang:"ko-KR",voiceURI:"v1",localService:true,default:true},
                  {name:"Cloud Natural",lang:"ko-KR",voiceURI:"v2",localService:false},
                  {name:"Microsoft Xiaoxiao Online (Natural)",lang:"zh-CN",voiceURI:"v3",localService:false}];
    window.__spoken=[];
    Object.defineProperty(window,"speechSynthesis",{value:{paused:false,getVoices:()=>voices,onvoiceschanged:null,
      speak(u){window.__spoken.push(u.text);setTimeout(()=>{u.onstart&&u.onstart({});setTimeout(()=>u.onend&&u.onend({}),20);},5);},
      cancel(){},pause(){},resume(){}},configurable:true});
    window.SpeechSynthesisUtterance=function(t){this.text=t;this.rate=1;this.pitch=1;this.volume=1;};
  });
  const p=await ctx.newPage();
  const errs=[]; p.on("pageerror",e=>errs.push("PAGEERR "+e.message));
  p.on("console",m=>{
    const t=m.text();
    if(m.type()!=="error") return;
    if(/CleanUnusedInitializers|AudioContext|autoplay/i.test(t)) return;
    if(BLOCK_MODELS && /404|Failed to load resource/i.test(t)) return;   // 이 시나리오에서는 404 가 정상이다
    errs.push(t);
  });
  await p.goto(base); await p.waitForTimeout(1200);
  await p.evaluate(()=>localStorage.clear()); await p.reload(); await p.waitForTimeout(1200);
  const skip=await p.$("#onbSkip"); if(skip){await skip.click();await p.waitForTimeout(300);}
    if (BLOCK_MODELS) {
    // 모델이 배포되지 않은 상태(기본 저장소)에서 AI 를 켜려 하면:
    // 배너로 알리고, 버튼은 다시 눌리고, 진행바는 사라지고, 앱은 기기 음성으로 계속 동작해야 한다
    await p.click("#aiBtn");
    await p.waitForFunction(()=>document.getElementById("voiceBanner").classList.contains("show"),null,{timeout:60000});
    ck("자산 없음: 배너 안내", (await p.textContent("#voiceBanner")).includes("AI 음성을 켤 수 없습니다"), (await p.textContent("#voiceBanner")).slice(0,60));
    ck("자산 없음: 진행바 정리됨", !(await p.evaluate(()=>document.getElementById("dlWrap").classList.contains("show"))));
    ck("자산 없음: AI 버튼 재활성화", !(await p.evaluate(()=>document.getElementById("aiBtn").disabled)));
    ck("자산 없음: 엔진은 system 유지", (await p.textContent("#engineBadge")).includes("system"));
    await p.fill("#script","기기 음성으로 계속 읽을 수 있어야 합니다.");
    await p.evaluate(()=>{ window.__spoken.length=0; });
    await p.click("#playBtn"); await p.waitForTimeout(1200);
    ck("자산 없음: 기기 음성으로 정상 낭독", (await p.evaluate(()=>window.__spoken.length))>0);
    const bad0=out.filter(c=>!c.ok);
    out.forEach(c=>console.log(`${c.ok?"  ok":"FAIL"}  ${c.n}${c.d?"  — "+c.d:""}`));
    console.log(`\nPASS ${out.length-bad0.length} / FAIL ${bad0.length}`);
    console.log("errors:", errs.length?errs.slice(0,6):"none");
    await b.close(); srv.close(); process.exit(bad0.length||errs.length?1:0);
  }

  ck("http 에서 모델 정보 표시", !(await p.textContent("#modelInfo")).includes("파일을 직접"), await p.textContent("#modelInfo"));

  await p.click("#aiBtn");
  await p.waitForFunction(()=>document.getElementById("engineBadge").textContent.includes("ai") ||
                              document.getElementById("voiceBanner").classList.contains("show"), null, {timeout:120000});
  const badge = await p.textContent("#engineBadge");
  ck("AI 음성 켜짐", badge.includes("ai"), badge);
  const variantUsed = await p.evaluate(()=>{ try { return Supertonic && window.__eng ? null : null; } catch(e){ return null; } });
  ck("매니페스트 변형 경로 해석", await p.evaluate(async ()=>{
    // 엔진이 variants 맵에서 네 모델 경로를 모두 뽑아내는지 직접 확인한다
    const e = new Supertonic.SupertonicEngine({ bases:["/models/supertonic-3/"], ortBase:"/vendor/ort/", variant:"int8" });
    const mf = await e.modelFiles();
    return !!(mf.duration_predictor && mf.text_encoder && mf.vector_estimator && mf.vocoder);
  }));
  ck("다운로드 진행바 숨김 복귀", !(await p.evaluate(()=>document.getElementById("dlWrap").classList.contains("show"))));

  await p.evaluate(()=>{ document.getElementById("voiceFold").open=true; });
  await p.waitForTimeout(300);
  const names = await p.$$eval("#vbList .vb-name", e=>e.map(x=>x.textContent));
  ck("AI 목소리 10개 노출", names.filter(n=>/·/.test(n)).length >= 10, names.length+"개 전체");
  ck("아나운서 목소리 최상단", names[0].includes("아나운서"), names[0]);

  // 목소리 섞기
  await p.evaluate(()=>document.querySelectorAll("details").forEach(d=>d.open=true));
  await p.waitForTimeout(300);
  await p.selectOption("#mixA","F3"); await p.selectOption("#mixB","M3");
  await p.fill("#mixName","나만의 앵커"); await p.click("#mixMake"); await p.waitForTimeout(600);
  const names2 = await p.$$eval("#vbList .vb-name", e=>e.map(x=>x.textContent));
  ck("혼합 목소리 생성", names2.includes("나만의 앵커"), names2.slice(0,3).join(" / "));

  // 대본 낭독 (신경망 경로)
  await p.fill("#script","안녕하십니까. 오늘의 뉴스입니다. 두 번째 문장입니다.");
  await p.evaluate(()=>{ window.__spoken.length=0; });
  await p.click("#playBtn");
  await p.waitForFunction(()=>!document.getElementById("playBtn").disabled &&
                              document.getElementById("bar").style.width==="100%", null, {timeout:180000});
  ck("AI 낭독 완주", (await p.evaluate(()=>document.getElementById("bar").style.width))==="100%");
  ck("낭독 후 트랜스포트 복귀", !(await p.evaluate(()=>document.getElementById("playBtn").disabled)));
  ck("AI 경로는 speechSynthesis 미사용", (await p.evaluate(()=>window.__spoken.length))===0,
     "spoken="+(await p.evaluate(()=>window.__spoken.length)));
  // 긴 글 모드
  await p.click("#modeLong"); await p.waitForTimeout(300);
  ck("긴 글 조각 수 표시", +(await p.textContent("#lfCount"))>0, await p.textContent("#lfCount"));
  await p.click("#lfStart");
  await p.waitForFunction(()=>!document.getElementById("lfSave").disabled, null, {timeout:180000});
  ck("긴 글 합성 완료·저장 가능", !(await p.evaluate(()=>document.getElementById("lfSave").disabled)));
  ck("긴 글 완료 조각 수", +(await p.textContent("#lfDone"))>0, await p.textContent("#lfDone"));
  // 긴 글: 일시정지 → 이어듣기 → 정지 후 다시 시작 가능해야 한다 (프라미스 교착 회귀 방지)
  await p.click("#lfStart");
  await p.waitForTimeout(700);
  await p.click("#lfPause"); await p.waitForTimeout(500);
  ck("긴 글 일시정지 표시", (await p.textContent("#lfPause")).includes("이어듣기"), await p.textContent("#lfPause"));
  await p.click("#lfPause"); await p.waitForTimeout(500);
  await p.click("#lfStop");
  await p.waitForFunction(()=>!document.getElementById("lfStart").disabled, null, {timeout:60000});
  ck("긴 글 정지 후 다시 시작 가능", !(await p.evaluate(()=>document.getElementById("lfStart").disabled)));
  ck("긴 글 정지 후 ON AIR 꺼짐", !(await p.evaluate(()=>document.body.classList.contains("playing"))));

  // 단어 모드 (신경망)
  await p.click("#modeWord"); await p.waitForTimeout(200);
  await p.fill("#wordInput","사과");
  await p.click("#wordPlay");
  await p.waitForFunction(()=>!document.getElementById("wordSave").disabled, null, {timeout:120000});
  ck("단어 WAV 저장 가능(AI)", !(await p.evaluate(()=>document.getElementById("wordSave").disabled)));
  // 단어 3번 반복 도중 모드를 바꾸면 더 읽지 않아야 한다
  await p.click("#modeWord"); await p.waitForTimeout(200);
  await p.fill("#wordInput","반복테스트");
  await p.evaluate(()=>{ window.__spoken.length=0; });
  await p.click("#wordRepeat"); await p.waitForTimeout(300);
  await p.click("#modeScript"); await p.waitForTimeout(1600);
  const spokenAfter = await p.evaluate(()=>window.__spoken.length);
  await p.waitForTimeout(1200);
  ck("단어 반복은 모드 전환에서 멈춘다", (await p.evaluate(()=>window.__spoken.length)) === spokenAfter,
     "after=" + spokenAfter + " later=" + (await p.evaluate(()=>window.__spoken.length)));

  // 재생 중 모드를 바꾸면 멈춰야 한다
  await p.click("#modeScript"); await p.waitForTimeout(200);
  await p.fill("#script","아주 긴 문장입니다. 두 번째. 세 번째. 네 번째. 다섯 번째 문장입니다.");
  await p.click("#playBtn"); await p.waitForTimeout(400);
  await p.click("#modeWord"); await p.waitForTimeout(700);
  ck("모드 전환이 재생을 정지", !(await p.evaluate(()=>document.getElementById("playBtn").disabled)) &&
     !(await p.evaluate(()=>document.body.classList.contains("playing"))));
  await p.click("#modeScript"); await p.waitForTimeout(200);

  // 중국어 → 신경망 미지원 폴백
  await p.click("#modeScript"); await p.waitForTimeout(200);
  await p.evaluate(()=>{ document.querySelector(String.raw`.lang[data-code="zh"]`).click(); });
  await p.waitForTimeout(500);
  ck("중국어는 미지원 배지", (await p.textContent("#engineBadge")).includes("미지원"), await p.textContent("#engineBadge"));
  await p.fill("#script","你好。");
  await p.evaluate(()=>{ window.__spoken.length=0; });
  await p.click("#playBtn"); await p.waitForTimeout(2500);
  ck("중국어는 기기 음성으로 폴백", (await p.evaluate(()=>window.__spoken.length))>0,
     "spoken="+(await p.evaluate(()=>window.__spoken.length)));

  const bad=out.filter(c=>!c.ok);
  out.forEach(c=>console.log(`${c.ok?"  ok":"FAIL"}  ${c.n}${c.d?"  — "+c.d:""}`));
  console.log(`\nPASS ${out.length-bad.length} / FAIL ${bad.length}`);
  console.log("errors:", errs.length?errs.slice(0,6):"none");
  await b.close(); srv.close();
  process.exit(bad.length||errs.length?1:0);
})().catch(e=>{
  console.error("EXCEPTION:", e.message);
  out.forEach(c=>console.log(`${c.ok?"  ok":"FAIL"}  ${c.n}${c.d?"  — "+c.d:""}`));
  process.exit(1);
});
