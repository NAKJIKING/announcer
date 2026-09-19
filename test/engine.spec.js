/* 신경망 엔진 통합 테스트 — 정적 서버 + 헤드리스 Chromium.
 *
 *   node test/engine.spec.js <root> [--base <모델 베이스>] [--real] [--out <디렉터리>]
 *
 * 기본은 test/fixtures/supertonic-3 (대체 모델: 배관만 검증, 음질 아님).
 * --real 은 실제 가중치용 — 합성 시간이 길어 타임아웃과 스텝 수를 키우고 WAV 를 저장한다.
 * 실가중치 검증은 GitHub Actions(test-neural.yml)에서 수행한다. 개발 컨테이너는 허깅페이스가 막혀 있다.
 */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const argv = process.argv.slice(2);
const ROOT = path.resolve(argv[0] || ".");
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REAL = argv.includes("--real");
const BASE = arg("--base", "test/fixtures/supertonic-3/");
// 하네스는 /test/ 아래에서 열리므로, 베이스는 사이트 루트 기준 절대경로로 넘긴다
const BASE_ABS = BASE.startsWith("http") || BASE.startsWith("/") ? BASE : "/" + BASE;
const OUT = arg("--out", null);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".onnx": "application/octet-stream", ".css": "text/css" };

function serve(root) {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.stat(f, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-store" });
      fs.createReadStream(f).pipe(res);
    });
  });
}

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });

(async () => {
  const srv = serve(ROOT);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERR " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/CleanUnusedInitializers/.test(m.text())) errs.push(m.text()); });

  await page.goto(origin + "test/engine.harness.html");
  const r = await page.evaluate(async (opt) => {
    try { return await runAll(opt); } catch (e) { return { fatal: e.message, stack: e.stack }; }
  }, { base: BASE_ABS, real: REAL, steps: REAL ? 8 : 4 });

  if (r.fatal) { console.error("FATAL:", r.fatal, "\n", r.stack); await b.close(); srv.close(); process.exit(1); }

  const sr = 44100;
  ck("설치: 모든 파일 캐시됨", r.installed);
  ck("설치: 조각난 파일 병합", r.cachedList.includes("onnx/vector_estimator.onnx") || r.cachedList.some(f => f.includes("vector_estimator")), r.cachedList.length + "개");
  ck("세션 생성", !!r.provider, r.provider);
  ck("단일 초기화(ortInit) 기록", !!r.ortInit, JSON.stringify(r.ortInit));
  ck("한국어 120자 상한 준수", r.chunks.every(n => n <= 120), JSON.stringify(r.chunks));
  ck("긴 글 자동 분할", r.r1.chunks > 1, r.r1.chunks + "조각");
  ck("조각 콜백 = 조각 수", r.r1.chunkEv.length === r.r1.chunks);
  ck("PCM 생성됨", r.r1.len > sr * 0.5, r.r1.len + " samples");
  ck("PCM 무음 아님", r.r1.rms > 0.001, "rms " + r.r1.rms);
  ck("샘플레이트 44.1kHz", r.r1.sr === sr, r.r1.sr);
  ck("같은 seed → 같은 결과", r.deterministic);
  ck("다른 seed → 다른 결과", r.seedChangesOutput);
  ck("목소리 혼합 동작", r.mixed.len > 0 && r.mixed.ttlDims.join("x") === "1x50x256", JSON.stringify(r.mixed.ttlDims));
  ck("스타일 JSON 왕복", r.mixed.roundTrip);
  ck("영어 합성", r.en.len > 0);
  ck("중단 시 AbortError", r.aborted === "AbortError", r.aborted);
  ck("WAV RIFF 헤더", r.wav.riff === "RIFF");
  ck("WAV 길이 일치", r.wav.dataLen === r.wav.expect, r.wav.dataLen + " vs " + r.wav.expect);
  ck("WAV 샘플레이트", r.wav.sr === sr);
  ck("두 번째 로드 성공", r.secondLoad === "ok", r.secondLoad);
  ck("두 번째 로드는 네트워크 0회", r.secondLoadFetches.length === 0, JSON.stringify(r.secondLoadFetches));
  if (REAL) {
    ck("실가중치: 합성 시간 기록", r.synthMs > 0, r.synthMs + "ms");
    ck("실가중치: 오디오가 정현파가 아님", r.r1.rms > 0.005 && r.r1.rms < 0.9, "rms " + r.r1.rms);
  }

  if (OUT && r.wavB64) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "sample.wav"), Buffer.from(r.wavB64, "base64"));
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(r, null, 1));
    console.log("wrote", OUT);
  }

  const failed = checks.filter(c => !c.ok);
  checks.forEach(c => console.log(`${c.ok ? "  ok" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`));
  console.log(`\nPASS ${checks.length - failed.length} / FAIL ${failed.length}`);
  console.log("provider:", r.provider, "| variant:", r.variantUsed, "| proxy:", r.proxy, "| threads:", r.threads, "| synth:", r.synthMs + "ms");
  console.log("errors:", errs.length ? errs : "none");
  await b.close(); srv.close();
  process.exit(failed.length || errs.length ? 1 : 0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
