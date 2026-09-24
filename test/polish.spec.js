/* 목소리 다듬기 — JS 구현이 파이썬 기준 구현과 같은 결과를 내는지 대조한다.
 *   node test/polish.spec.js <입력.wav> [출력디렉터리]
 * 파이썬 쪽(tools/voice_polish.py)을 같은 파일에 돌린 뒤 지표를 비교한다. */
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const VP = require(path.join(__dirname, "..", "engine", "voice-polish.js"));

function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("WAV 아님: " + p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10),
                               sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") data = { off: off + 8, size: sz };
    off += 8 + sz + (sz & 1);
  }
  const { ch, sr, bits, format } = fmt;
  const n = Math.floor(data.size / (bits / 8) / ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const o = data.off + (i * ch + c) * (bits / 8);
      s += format === 3 ? b.readFloatLE(o) : (bits === 16 ? b.readInt16LE(o) / 32768 : b.readInt32LE(o) / 2147483648);
    }
    out[i] = s / ch;
  }
  return { pcm: out, sr };
}

const SRC = process.argv[2];
const OUT = process.argv[3] || require("os").tmpdir();
if (!SRC) { console.error("사용법: node test/polish.spec.js <입력.wav> [출력디렉터리]"); process.exit(2); }

const checks = [];
const ck = (n, ok, d) => checks.push({ n, ok: !!ok, d: d === undefined ? "" : String(d) });

const { pcm, sr } = readWav(SRC);
console.log(`입력: ${(pcm.length / sr).toFixed(1)}s @ ${sr}Hz\n`);

for (const preset of Object.keys(VP.PRESETS)) {
  const t0 = Date.now();
  const r = VP.polish(pcm, sr, { preset });
  const ms = Date.now() - t0;
  const jsOut = path.join(OUT, `js-${preset}.wav`);
  fs.writeFileSync(jsOut, Buffer.from(VP.toWav(r.pcm, sr)));

  // 파이썬 기준 구현
  const pyOut = path.join(OUT, `py-${preset}.wav`);
  let py = null;
  try {
    execFileSync("python3", [path.join(__dirname, "..", "tools", "voice_polish.py"), SRC, "-o", pyOut, "--preset", preset],
                 { stdio: "pipe" });
    const pyJson = execFileSync("python3", ["-c", `
import sys,json,numpy as np,soundfile as sf
sys.path.insert(0,"${path.join(__dirname, "..", "tools")}")
from voice_polish import measure
x,sr=sf.read("${pyOut}",dtype="float32")
if x.ndim>1: x=x.mean(1)
m=measure(x,sr,"py"); m.pop("label")
print(json.dumps({k:float(v) for k,v in m.items()}))`], { stdio: "pipe" }).toString();
    py = JSON.parse(pyJson);
  } catch (e) { console.log(`  (파이썬 대조 건너뜀: ${String(e.message).split("\n")[0].slice(0, 80)})`); }

  console.log(`── ${preset} (${ms}ms) ──`);
  console.log(`  라우드니스 ${r.before.lufs.toFixed(1)} → ${r.after.lufs.toFixed(1)} LUFS`);
  console.log(`  트루피크   ${r.before.truePeak.toFixed(1)} → ${r.after.truePeak.toFixed(1)} dBTP`);
  console.log(`  음량편차   ${r.before.variation.toFixed(1)} → ${r.after.variation.toFixed(1)} dB`);
  console.log(`  S/N        ${r.before.snr.toFixed(1)} → ${r.after.snr.toFixed(1)} dB`);

  // 절대 기준: 이 값들은 구현과 무관하게 지켜야 한다
  ck(`${preset}: 라우드니스 목표 -16 LUFS`, Math.abs(r.after.lufs + 16) < 1.0, r.after.lufs.toFixed(2));
  ck(`${preset}: 트루피크 -1dBTP 이하`, r.after.truePeak <= -0.5, r.after.truePeak.toFixed(2));
  ck(`${preset}: 음량 편차 감소`, r.after.variation < r.before.variation, `${r.before.variation.toFixed(1)}→${r.after.variation.toFixed(1)}`);
  ck(`${preset}: 클리핑 없음`, r.after.peak < 0, r.after.peak.toFixed(2));
  ck(`${preset}: 길이 보존`, r.pcm.length === pcm.length);
  ck(`${preset}: NaN 없음`, !r.pcm.some(v => !isFinite(v)));

  if (py) {
    console.log(`  파이썬 대조: LUFS ${py.lufs.toFixed(1)} / TP ${py.tp.toFixed(1)} / 편차 ${py.var.toFixed(1)}`);
    ck(`${preset}: 파이썬과 라우드니스 일치(±1dB)`, Math.abs(py.lufs - r.after.lufs) < 1.0,
       `py ${py.lufs.toFixed(2)} vs js ${r.after.lufs.toFixed(2)}`);
    ck(`${preset}: 파이썬과 음량편차 일치(±2.5dB)`, Math.abs(py.var - r.after.variation) < 2.5,
       `py ${py.var.toFixed(2)} vs js ${r.after.variation.toFixed(2)}`);
    ck(`${preset}: 파이썬과 S/N 일치(±3dB)`, Math.abs(py.snr - r.after.snr) < 3.0,
       `py ${py.snr.toFixed(2)} vs js ${r.after.snr.toFixed(2)}`);
  }
  console.log("");
}

const bad = checks.filter(c => !c.ok);
checks.forEach(c => console.log(`${c.ok ? "  ok" : "FAIL"}  ${c.n}${c.d ? "  — " + c.d : ""}`));
console.log(`\nPASS ${checks.length - bad.length} / FAIL ${bad.length}`);
process.exit(bad.length ? 1 : 0);
