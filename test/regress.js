const { chromium } = require("playwright");
const FILE = process.env.ANNOUNCER_URL || "file:///home/user/project-all/아나운서/아나운서.html";
const pass = [], fail = [];
const ck = (name, cond, detail="") => (cond ? pass : fail).push(name + (detail ? " — " + detail : ""));

(async () => {
  const errs = [];
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport:{width:412,height:915}, isMobile:true });
  // 가짜 TTS: 음성 목록 + 즉시 콜백 + 발화 기록
  await ctx.addInitScript(() => {
    const voices = [
      { name:"Local Basic", lang:"ko-KR", voiceURI:"v-local", localService:true, default:true },
      { name:"Cloud Natural", lang:"ko-KR", voiceURI:"v-net", localService:false, default:false },
      { name:"Male Injoon", lang:"ko-KR", voiceURI:"v-m", localService:true, default:false },
      { name:"English Aria", lang:"en-US", voiceURI:"v-en", localService:false, default:false },
    ];
    window.__spoken = [];
    const synth = { paused:false, getVoices:()=>voices, onvoiceschanged:null,
      speak(u){ window.__spoken.push({text:u.text, rate:u.rate, pitch:u.pitch, voice:u.voice&&u.voice.name});
        setTimeout(()=>{ u.onstart&&u.onstart({}); setTimeout(()=>u.onend&&u.onend({}), 25); }, 8); },
      cancel(){}, pause(){this.paused=true;}, resume(){this.paused=false;} };
    Object.defineProperty(window,"speechSynthesis",{value:synth,configurable:true});
    window.SpeechSynthesisUtterance = function(t){ this.text=t; this.rate=1; this.pitch=1; this.volume=1; };
  });
  const p = await ctx.newPage();
  p.on("pageerror", e=>errs.push("PAGEERR: "+e.message));
  p.on("console", m=>{ if(m.type()==="error") errs.push(m.text()); });
  await p.goto(FILE); await p.waitForTimeout(900);
  await p.evaluate(()=>{ localStorage.clear(); });
  await p.reload(); await p.waitForTimeout(900);

  // [온보딩]
  ck("온보딩 첫 실행 표시", await p.evaluate(()=>document.getElementById("onb").classList.contains("show")));
  await p.click("#onbSkip"); await p.waitForTimeout(200);
  ck("온보딩 건너뛰기", await p.evaluate(()=>!document.getElementById("onb").classList.contains("show")));

  // [음성 선택] 온라인 음성 우선
  const slot1 = await p.$eval("#femaleRow .ann .vname", el=>el.textContent);
  ck("신경망 음성 우선 선택", slot1.includes("Cloud"), slot1.trim());

  // [빠른 시작]
  ck("빠른시작 표시(빈 대본)", await p.evaluate(()=>!document.getElementById("quickstart").classList.contains("hide")));
  await p.click('#quickstart button[data-qs="news"]'); await p.waitForTimeout(400);
  ck("빠른시작 대본 채움", (await p.inputValue("#script")).length > 10);

  // [접이식 UI]
  ck("언어·목소리 접힘", await p.$eval("#voiceFold", el=>!el.open));
  ck("설정 그룹 11개", (await p.$$eval(".sgroup", e=>e.length)) === 11, (await p.$$eval(".sgroup", e=>e.length)) + "개");
  await p.evaluate(()=>document.querySelectorAll(".sgroup").forEach(d=>d.open=true));
  await p.waitForTimeout(200);

  // [자연 억양 프로소디]
  ck("자연 억양 기본 ON", await p.isChecked("#naturalChk"));
  await p.fill("#script","안녕하십니까, 시청자 여러분. 정말 좋은가요? 네, 그렇습니다!");
  await p.evaluate(()=>{ window.__spoken.length = 0; });
  await p.click("#playBtn"); await p.waitForTimeout(3000);
  const spoken = await p.evaluate(()=>window.__spoken.map(x=>({t:x.text,r:+x.rate.toFixed(3),p:+x.pitch.toFixed(3)})));
  ck("절 단위 분할 발화", spoken.length > 3, spoken.length+"조각");
  ck("속도 미세 변화", new Set(spoken.map(x=>x.r)).size > 1);
  ck("재생 완주", (await p.evaluate(()=>document.getElementById("bar").style.width)) === "100%");

  // [대본 관리]
  await p.fill("#script","사과 대본입니다."); await p.click("#saveBtn"); await p.waitForTimeout(200);
  await p.fill("#script","바나나 대본입니다."); await p.click("#saveBtn"); await p.waitForTimeout(200);
  await p.click("#libBtn"); await p.waitForTimeout(300);
  ck("보관함 2건", (await p.$$eval("#libList .lib-item", e=>e.length)) === 2);
  await p.fill("#libSearch","바나나"); await p.waitForTimeout(300);
  ck("대본 검색", (await p.$$eval("#libList .lib-item", e=>e.length)) === 1);
  await p.fill("#libSearch",""); await p.waitForTimeout(200);
  ck("언어 태그 필터 존재", (await p.$$eval("#libTags button", e=>e.length)) >= 2);
  await p.click("#libClose"); await p.waitForTimeout(150);

  // [프리셋]
  await p.evaluate(()=>document.querySelectorAll(".sgroup").forEach(d=>d.open=true));
  await p.click("#presetSave"); await p.waitForTimeout(250);
  ck("프리셋 저장", (await p.$$eval("#presetList .preset-chip", e=>e.length)) === 1);
  await p.click('#speedPresets button[data-r="1.4"]'); await p.waitForTimeout(150);
  const changed = await p.textContent("#rateVal");
  await p.click("#presetList .pn"); await p.waitForTimeout(300);
  ck("프리셋 적용 복원", (await p.textContent("#rateVal")) !== changed);

  // [글자크기 / 예상시간 / 선택재생]
  const f0 = await p.evaluate(()=>getComputedStyle(document.getElementById("script")).fontSize);
  await p.click("#fontBtn"); await p.waitForTimeout(200);
  ck("글자 크기 순환", (await p.evaluate(()=>getComputedStyle(document.getElementById("script")).fontSize)) !== f0);
  await p.fill("#script","안녕하십니까. 오늘의 뉴스입니다."); await p.waitForTimeout(1000);
  ck("예상 시간 표시", (await p.textContent("#estimate")).includes("초"));
  await p.evaluate(()=>{ const s=document.getElementById("script"); s.focus(); s.setSelectionRange(0,6); });
  await p.evaluate(()=>{ window.__spoken.length=0; });
  await p.click("#selBtn"); await p.waitForTimeout(300);
  ck("선택 재생", (await p.evaluate(()=>window.__spoken.length)) > 0);

  // [접근성]
  const noName = await p.evaluate(()=>{ let n=0; document.querySelectorAll("button").forEach(el=>{
    const t=(el.getAttribute("aria-label")||el.textContent||"").replace(/\s/g,"");
    if(!/[A-Za-z0-9가-힣]/.test(t)) n++; }); return n; });
  ck("이름 없는 버튼 0개", noName === 0, noName+"개");
  const live = await p.evaluate(()=>({
    regions: document.querySelectorAll('[aria-live],[role="status"],[role="alert"]').length,
    metaSilent: !document.getElementById("meta").hasAttribute("aria-live"),
    bannerAlert: document.getElementById("voiceBanner").getAttribute("role") === "alert",
  }));
  ck("라이브 리전 3곳 이상", live.regions >= 3, live.regions+"곳");
  ck("#meta는 TTS 간섭 방지로 무음", live.metaSilent);
  ck("오류 배너 role=alert", live.bannerAlert);
  ck("스킵 링크", (await p.$(".skip-link")) !== null);

  // [테마]
  await p.click("#themeBtn"); await p.waitForTimeout(400);
  ck("라이트 전환", (await p.evaluate(()=>document.documentElement.getAttribute("data-theme"))) === "light");
  const lightRec = await p.evaluate(()=>getComputedStyle(document.querySelector("#recBtn")).backgroundColor);
  ck("라이트 녹음버튼 밝음", !lightRec.includes("26, 15, 14"), lightRec);
  await p.reload(); await p.waitForTimeout(800);
  ck("테마 저장", (await p.evaluate(()=>document.documentElement.getAttribute("data-theme"))) === "light");
  await p.click("#themeBtn"); await p.waitForTimeout(300);

  // [콘솔 디자인 시스템]
  const design = await p.evaluate(()=>{
    const cs=(s,pr)=>{const el=document.querySelector(s); return el?getComputedStyle(el)[pr]:null;};
    return { bodyBg: cs("body","backgroundColor"), foldR: cs(".fold","borderRadius"),
      labelSize: cs(".section-label","fontSize"), labelLS: cs(".section-label","letterSpacing"),
      valFam: cs(".field .val","fontFamily"),
      metaFam: cs(".meta","fontFamily"), langR: cs(".lang","borderRadius"),
      progMask: cs(".progress","webkitMaskImage") || cs(".progress","maskImage") };
  });
  ck("구분선 그리드 바탕", design.bodyBg === "rgb(35, 35, 35)", design.bodyBg);
  ck("각진 패널", design.foldR === "0px", design.foldR);
  ck("한글 라벨 가독 크기", parseFloat(design.labelSize) >= 12, design.labelSize);
  ck("한글 라벨 자간 정상", design.labelLS === "normal" || parseFloat(design.labelLS) === 0, design.labelLS);
  ck("모노 카운터(숫자)", /mono/i.test(design.metaFam));
  ck("모노 수치 readout", /mono/i.test(design.valFam));
  ck("각진 컨트롤", parseFloat(design.langR) <= 3, design.langR);
  ck("LED 세그먼트 미터", design.progMask && design.progMask.includes("repeating"), String(design.progMask).slice(0,40));

  // [기능 복구 회귀 방지]
  await p.fill("#script","첫 문장입니다. 둘째 문장입니다.");
  await p.click("#playBtn"); await p.waitForTimeout(600);
  const pr = await p.evaluate(()=>{
    const sc=document.getElementById("script"), cur=document.querySelector("#overlay .cur");
    return { scBg: getComputedStyle(sc).backgroundColor, scPE: getComputedStyle(sc).pointerEvents,
             curBg: cur?getComputedStyle(cur).backgroundColor:null };
  });
  ck("읽기중 대본칸 투명(하이라이트 노출)", pr.scBg === "rgba(0, 0, 0, 0)", pr.scBg);
  ck("읽기중 클릭이 오버레이로 통과", pr.scPE === "none");
  ck("현재문장 엠버 틴트 구분", pr.curBg && pr.curBg.includes("224, 129, 63"), String(pr.curBg));
  await p.waitForTimeout(1200);

  // [JS 생성 컨트롤 키보드 접근]
  const kbd = await p.evaluate(()=>({
    presetBtn: !document.querySelector("#presetList .pn") || document.querySelector("#presetList .pn").tagName === "BUTTON",
    libBtn: !document.querySelector("#libList .t") || document.querySelector("#libList .t").tagName === "BUTTON",
    annPressed: !document.querySelector(".ann") || document.querySelector(".ann").hasAttribute("aria-pressed"),
  }));
  ck("프리셋 칩 키보드 조작 가능", kbd.presetBtn);
  ck("보관함 항목 키보드 조작 가능", kbd.libBtn);
  ck("아나운서 슬롯 aria-pressed", kbd.annPressed);


  // [모드 탭]
  ck("모드 탭 3개", (await p.$$eval(".modebar button", e=>e.length)) === 3);
  ck("대본 탭이 기본", await p.evaluate(()=>!document.getElementById("paneScript").hidden && document.getElementById("paneWord").hidden));
  await p.click("#modeWord"); await p.waitForTimeout(200);
  ck("단어 탭 전환", await p.evaluate(()=>!document.getElementById("paneWord").hidden && document.getElementById("paneScript").hidden));
  ck("단어 탭 aria-selected", await p.getAttribute("#modeWord","aria-selected") === "true");
  await p.fill("#wordInput","사과");
  await p.evaluate(()=>{ window.__spoken.length = 0; });
  await p.click("#wordPlay"); await p.waitForTimeout(600);
  ck("단어 모드 발음", (await p.evaluate(()=>window.__spoken.length)) > 0);
  ck("단어 기록 저장", (await p.$$eval("#wordHist button", e=>e.length)) >= 1);
  await p.click("#modeLong"); await p.waitForTimeout(200);
  ck("긴 글 탭 전환", await p.evaluate(()=>!document.getElementById("paneLong").hidden));
  ck("긴 글 AI 필요 안내", (await p.textContent("#lfHint")).includes("AI"));
  await p.click("#modeScript"); await p.waitForTimeout(200);

  // [음성 브라우저]
  await p.evaluate(()=>{ document.getElementById("voiceFold").open = true; });
  await p.waitForTimeout(200);
  const vbN = await p.$$eval("#vbList .vb-item", e=>e.length);
  ck("음성 브라우저 목록", vbN >= 1, vbN + "개");
  ck("음성 항목 aria-pressed", await p.evaluate(()=>{ const b=document.querySelector("#vbList .vb-item"); return !!b && b.hasAttribute("aria-pressed"); }));
  ck("미리듣기 버튼 이름 있음", await p.evaluate(()=>{ const b=document.querySelector("#vbList .vb-play"); return !!b && !!b.getAttribute("aria-label"); }));
  await p.fill("#vbSearch","zzzz-없는목소리"); await p.waitForTimeout(250);
  ck("음성 검색 필터", (await p.$$eval("#vbList .vb-empty", e=>e.length)) === 1);
  await p.fill("#vbSearch",""); await p.waitForTimeout(200);

  // [엔진]
  ck("엔진 배지 기본 system", (await p.textContent("#engineBadge")).includes("system"));
  ck("file:// 에서 AI 안내", (await p.textContent("#modelInfo")).length > 0);

  // [효과음/설정 유지]
  ck("효과음 기본 켜짐", await p.isChecked("#sfxChk"));
  await p.evaluate(()=>{ const c=document.getElementById("sfxChk"); c.checked=false; c.dispatchEvent(new Event("change")); });
  await p.waitForTimeout(200);
  await p.reload(); await p.waitForTimeout(900);
  ck("효과음 설정 저장", !(await p.isChecked("#sfxChk")));
  await p.evaluate(()=>{ const c=document.getElementById("sfxChk"); c.checked=true; c.dispatchEvent(new Event("change")); });
  await p.waitForTimeout(150);

  // [VU 미터 / ON AIR]
  ck("VU 미터 12칸", (await p.$$eval("#vuMeter i", e=>e.length)) === 12);
  ck("ON AIR 표시 존재", (await p.$("#onAir")) !== null);

  // [선 아이콘]
  ck("선 아이콘 삽입됨", (await p.$$eval("svg.ic", e=>e.length)) >= 10, (await p.$$eval("svg.ic", e=>e.length)) + "개");

  // [모션 축소 존중]
  ck("prefers-reduced-motion 규칙", await p.evaluate(()=>
    Array.from(document.styleSheets).some(ss=>{ try { return Array.from(ss.cssRules).some(r=>r.conditionText && r.conditionText.includes("reduced-motion")); } catch(e){ return false; } })));


  // [라이선스 고지 — 사용자 요구: 저작권 문제 없을 것]
  await p.evaluate(()=>document.querySelectorAll("details").forEach(d=>d.open=true));
  await p.waitForTimeout(200);
  const lic = await p.evaluate(()=>document.body.innerText);
  ck("OpenRAIL-M 고지 노출", lic.includes("OpenRAIL-M"));
  ck("MIT 고지 노출", lic.includes("MIT"));
  ck("사용 제한(성대모사) 안내", lic.includes("흉내"));
  ck("모델 라이선스 링크", (await p.getAttribute("#licLink","href") || "").includes("LICENSE"));

  // [앰버 위 글자색 토큰이 계산 가능해야 한다 (자기참조 버그 회귀 방지)]
  const onAcc = await p.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim());
  ck("--on-accent 토큰 유효", /^#|rgb/.test(onAcc), onAcc || "(빈 값)");

  // [모드 탭 키보드 이동]
  await p.click("#modeScript");
  await p.evaluate(()=>document.getElementById("modeScript").focus());
  await p.keyboard.press("ArrowRight"); await p.waitForTimeout(200);
  ck("탭 화살표 이동", await p.evaluate(()=>document.activeElement.id === "modeWord"), await p.evaluate(()=>document.activeElement.id));
  ck("선택 안 된 탭은 tabindex -1", await p.evaluate(()=>document.getElementById("modeLong").tabIndex === -1));
  await p.click("#modeScript"); await p.waitForTimeout(150);

  console.log("PASS " + pass.length + " / FAIL " + fail.length);
  if (fail.length) { console.log("\n❌ 실패:"); fail.forEach(f=>console.log("  - "+f)); }
  console.log("\nerrors:", errs.length ? errs : "none");
  await b.close();
  if (fail.length || errs.length) process.exit(1);
})().catch(e=>{ console.error("FAIL:", e.message); process.exit(1); });
