/* 아나운서 · 목소리 다듬기 (브라우저용 방송 후처리 체인)
 *
 * tools/voice_polish.py 와 같은 처리를 브라우저에서 한다. 두 구현의 결과가 어긋나면
 * 파이썬 쪽이 기준이다 — test/polish.spec.js 가 두 결과의 지표를 비교한다.
 *
 * 체인: DC제거·하이패스 → 스펙트럼 노이즈 게이트 → EQ → 디에서 → 컴프 →
 *       라우드니스 정규화(BS.1770-4) → 트루피크 리미터
 *
 * 전부 Float32Array 위에서 직접 돈다. WebAudio 노드를 쓰지 않는 이유는 디에서·리미터가
 * 샘플 단위 동적 게인이라 노드 그래프로는 정확히 재현하기 어렵기 때문이다.
 */
(function (global) {
  'use strict';

  // ───────── FFT (반복형 radix-2) ─────────
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // ───────── 바이쿼드 ─────────
  function applyBiquad(x, b0, b1, b2, a1, a2) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
    }
    return y;
  }
  function highpass(x, sr, f0, Q) {
    const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
    const a0 = 1 + al;
    return applyBiquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  }
  function peaking(x, sr, f0, gainDb, Q) {
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / sr;
    const c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al / A;
    return applyBiquad(x, (1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0, -2 * c / a0, (1 - al / A) / a0);
  }
  function highShelf(x, sr, f0, gainDb, S) {
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / sr;
    const c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / (S || 0.7) - 1) + 2);
    const tsa = 2 * Math.sqrt(A) * al;
    const a0 = (A + 1) - (A - 1) * c + tsa;
    return applyBiquad(x,
      A * ((A + 1) + (A - 1) * c + tsa) / a0,
      -2 * A * ((A - 1) + (A + 1) * c) / a0,
      A * ((A + 1) + (A - 1) * c - tsa) / a0,
      (2 * ((A - 1) - (A + 1) * c)) / a0,
      ((A + 1) - (A - 1) * c - tsa) / a0);
  }
  function bandpass(x, sr, lo, hi) {
    // 2차 하이패스 + 2차 로우패스
    let y = highpass(x, sr, lo, 0.707);
    const w = 2 * Math.PI * Math.min(hi, sr / 2 * 0.99) / sr;
    const c = Math.cos(w), al = Math.sin(w) / (2 * 0.707), a0 = 1 + al;
    return applyBiquad(y, (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  }

  // ───────── 포락선 (정류 + 어택/릴리즈 추종) ─────────
  function envelope(x, sr, attack, release) {
    const aa = Math.exp(-1 / (attack * sr)), ar = Math.exp(-1 / (release * sr));
    const e = new Float32Array(x.length);
    let prev = 0;
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      const co = v > prev ? aa : ar;
      prev = co * prev + (1 - co) * v;
      e[i] = prev;
    }
    return e;
  }

  // ───────── 스펙트럼 노이즈 게이트 ─────────
  function denoise(x, sr, strength) {
    const N = 2048, hop = N / 4, half = N / 2 + 1;
    if (x.length < N * 4) return x;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const frames = Math.floor((x.length - N) / hop) + 1;
    const mag = [], ph = [], energy = new Float32Array(frames);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let t = 0; t < frames; t++) {
      const off = t * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      const m = new Float32Array(half), p = new Float32Array(half);
      let e = 0;
      for (let k = 0; k < half; k++) {
        m[k] = Math.hypot(re[k], im[k]); p[k] = Math.atan2(im[k], re[k]); e += m[k];
      }
      mag.push(m); ph.push(p); energy[t] = e / half;
    }
    // 조용한 25% 프레임에서 잡음 프로파일(주파수별 중앙값)
    const order = Array.from(energy.keys()).sort((a, b) => energy[a] - energy[b]);
    const quiet = order.slice(0, Math.max(4, Math.floor(frames * 0.25)));
    const prof = new Float32Array(half);
    const tmp = new Float32Array(quiet.length);
    for (let k = 0; k < half; k++) {
      for (let i = 0; i < quiet.length; i++) tmp[i] = mag[quiet[i]][k];
      const s = Array.prototype.slice.call(tmp).sort((a, b) => a - b);
      prof[k] = s[s.length >> 1];
    }
    const over = 1.6 * strength, floorG = Math.pow(10, -14 * strength / 20);
    // 게인 계산 + 시간축 평활 (인공음 억제)
    const prevG = new Float32Array(half).fill(1);
    for (let t = 0; t < frames; t++) {
      const m = mag[t];
      for (let k = 0; k < half; k++) {
        let g = Math.max(m[k] - over * prof[k], 0) / Math.max(m[k], 1e-12);
        g = Math.max(g, floorG);
        g = 0.35 * g + 0.65 * prevG[k];      // 1차 저역통과
        prevG[k] = g;
        m[k] *= g;
      }
    }
    // 겹쳐더하기 복원
    const out = new Float32Array(x.length), norm = new Float32Array(x.length);
    for (let t = 0; t < frames; t++) {
      const m = mag[t], p = ph[t];
      for (let k = 0; k < half; k++) { re[k] = m[k] * Math.cos(p[k]); im[k] = m[k] * Math.sin(p[k]); }
      for (let k = half; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
      fft(re, im, true);
      const off = t * hop;
      for (let i = 0; i < N; i++) {
        if (off + i >= out.length) break;
        out[off + i] += re[i] * win[i]; norm[off + i] += win[i] * win[i];
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-8 ? out[i] / norm[i] : x[i];
    return out;
  }

  // ───────── 디에서 ─────────
  function deess(x, sr, threshDb, ratio) {
    const s = bandpass(x, sr, 5000, 9500);
    const env = envelope(s, sr, 0.002, 0.05);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const edb = 20 * Math.log10(Math.max(env[i], 1e-9));
      const overDb = Math.max(edb - threshDb, 0);
      const g = Math.pow(10, (-overDb * (1 - 1 / ratio)) / 20);
      y[i] = x[i] - s[i] + s[i] * g;
    }
    return y;
  }

  // ───────── 컴프레서 ─────────
  function compress(x, sr, threshDb, ratio, attack, release, kneeDb) {
    const env = envelope(x, sr, attack, release);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const edb = 20 * Math.log10(Math.max(env[i], 1e-9));
      const o = edb - threshDb;
      let red;
      if (o <= -kneeDb / 2) red = 0;
      else if (o >= kneeDb / 2) red = o * (1 - 1 / ratio);
      else red = (1 - 1 / ratio) * Math.pow(o + kneeDb / 2, 2) / (2 * kneeDb);
      y[i] = x[i] * Math.pow(10, -red / 20);
    }
    return y;
  }

  // ───────── 라우드니스 (ITU-R BS.1770-4) ─────────
  function kWeight(x, sr) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    let y = applyBiquad(x, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
                        2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / sr); a0 = 1 + K / Q + K * K;
    return applyBiquad(y, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  }
  function lufs(x, sr) {
    const y = kWeight(x, sr), bs = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
    if (y.length < bs) return -70;
    const blocks = [];
    for (let i = 0; i + bs <= y.length; i += hop) {
      let s = 0; for (let k = i; k < i + bs; k++) s += y[k] * y[k];
      blocks.push(s / bs);
    }
    const L = blocks.map(b => -0.691 + 10 * Math.log10(Math.max(b, 1e-20)));
    let sel = L.map(v => v > -70);
    if (!sel.some(Boolean)) return -70;
    let sum = 0, cnt = 0;
    blocks.forEach((b, i) => { if (sel[i]) { sum += b; cnt++; } });
    const rel = -0.691 + 10 * Math.log10(sum / cnt) - 10;
    sel = L.map(v => v > -70 && v > rel);
    if (!sel.some(Boolean)) return -70;
    sum = 0; cnt = 0;
    blocks.forEach((b, i) => { if (sel[i]) { sum += b; cnt++; } });
    return -0.691 + 10 * Math.log10(sum / cnt);
  }

  // ───────── 트루피크 리미터 (4배 오버샘플) ─────────
  function truePeakDb(x) {
    const up = upsample4(x);
    let p = 0; for (let i = 0; i < up.length; i++) { const a = Math.abs(up[i]); if (a > p) p = a; }
    return p <= 0 ? -120 : 20 * Math.log10(p);
  }
  function upsample4(x) {
    // 선형보간 4배 — 트루피크 추정용으로 충분하다
    const n = x.length, up = new Float32Array(n * 4);
    for (let i = 0; i < n - 1; i++) {
      const a = x[i], b = x[i + 1];
      up[i * 4] = a; up[i * 4 + 1] = a + (b - a) * .25;
      up[i * 4 + 2] = a + (b - a) * .5; up[i * 4 + 3] = a + (b - a) * .75;
    }
    up[(n - 1) * 4] = x[n - 1];
    return up;
  }
  /* 리미터는 '피크만' 깎아야 한다. 어택/릴리즈 포락선을 그대로 쓰면 큰 피크 뒤로
     릴리즈 시간만큼 계속 눌려서, 말소리처럼 피크가 잦은 신호는 전체 음량이 무너진다
     (실제로 그렇게 만들었다가 라우드니스가 목표보다 11dB 낮게 나왔다).
     짧은 창의 이동최대값을 쓰면 피크 근처에서만 감쇠가 걸린다. */
  function slidingMaxAbs(x, w) {
    const n = x.length, out = new Float32Array(n);
    const dq = new Int32Array(n); let head = 0, tail = 0;   // 단조 감소 덱
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      while (tail > head && Math.abs(x[dq[tail - 1]]) <= a) tail--;
      dq[tail++] = i;
      if (dq[head] <= i - w) head++;
      out[i] = Math.abs(x[dq[head]]);
    }
    // 창의 절반만큼 앞쪽으로 당겨 룩어헤드 효과를 준다
    const sh = Math.floor(w / 2), y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = out[Math.min(n - 1, i + sh)];
    return y;
  }
  function smooth(x, w) {
    const n = x.length, y = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += x[i];
      if (i >= w) acc -= x[i - w];
      y[i] = acc / Math.min(i + 1, w);
    }
    return y;
  }
  function limit(x, sr, ceilDb) {
    const ceil = Math.pow(10, ceilDb / 20);
    const w = Math.max(2, Math.round(0.002 * sr));
    const env = smooth(slidingMaxAbs(x, w), w);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const e = Math.max(env[i], Math.abs(x[i]), 1e-9);
      y[i] = x[i] * Math.min(1, ceil / e);
    }
    let p = 0; for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > p) p = a; }
    if (p > ceil) { const s = ceil / p; for (let i = 0; i < y.length; i++) y[i] *= s; }
    return y;
  }

  // ───────── 측정 ─────────
  function measure(x, sr) {
    const fr = Math.round(0.1 * sr), n = Math.floor(x.length / fr) * fr;
    const edb = [];
    for (let i = 0; i < n; i += fr) {
      let s = 0; for (let k = i; k < i + fr; k++) s += x[k] * x[k];
      edb.push(20 * Math.log10(Math.sqrt(s / fr) + 1e-20));
    }
    const sorted = edb.slice().sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
    const thr = pct(60) - 12;
    const sp = edb.filter(v => v > thr), nz = edb.filter(v => v <= thr);
    const med = (arr) => { if (!arr.length) return -120; const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
    const q = (arr, p) => { if (!arr.length) return -120; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))]; };
    let peak = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    const speech = med(sp), floor = med(nz);
    return {
      peak: peak <= 0 ? -120 : 20 * Math.log10(peak),
      truePeak: truePeakDb(x),
      lufs: lufs(x, sr),
      floor: floor, speech: speech, snr: speech - floor,
      variation: q(sp, 90) - q(sp, 10),
    };
  }

  const PRESETS = {
    natural:   { label: '자연스럽게', hp: 70, mud: -2.5, pres: 2.5, air: 1.5, deess: -26, ratio: 2.5, nr: 0.7,
                 desc: '원래 음색을 많이 남기면서 또렷하게' },
    broadcast: { label: '방송용',     hp: 80, mud: -4.0, pres: 4.5, air: 3.0, deess: -28, ratio: 3.2, nr: 1.0,
                 desc: '가장 또렷합니다. 뉴스 낭독에 어울림' },
    warm:      { label: '따뜻하게',   hp: 65, mud: -1.5, pres: 2.0, air: 1.0, deess: -25, ratio: 2.8, nr: 0.8,
                 desc: '저음을 살립니다. 내레이션·오디오북에' },
  };

  /** @returns {{pcm: Float32Array, before: object, after: object}} */
  function polish(pcm, sr, opts) {
    const o = opts || {};
    const p = PRESETS[o.preset] || PRESETS.broadcast;
    const targetLufs = o.lufs == null ? -16 : o.lufs;
    const ceilDb = o.ceil == null ? -1 : o.ceil;
    const on = (k) => o.steps ? o.steps[k] !== false : true;
    const tick = o.onProgress || function () {};

    const before = measure(pcm, sr);
    let y = new Float32Array(pcm.length);
    let mean = 0; for (let i = 0; i < pcm.length; i++) mean += pcm[i];
    mean /= pcm.length || 1;
    for (let i = 0; i < pcm.length; i++) y[i] = pcm[i] - mean;

    tick(0.05, '저역 정리');   if (on('hp')) y = highpass(y, sr, p.hp, 0.707);
    tick(0.15, '잡음 제거');   if (on('nr')) y = denoise(y, sr, p.nr);
    tick(0.55, '음색 보정');
    if (on('eq')) { y = peaking(y, sr, 260, p.mud, 1.1); y = peaking(y, sr, 3400, p.pres, 0.9); y = highShelf(y, sr, 9500, p.air, 0.7); }
    tick(0.70, '치찰음 정리'); if (on('deess')) y = deess(y, sr, p.deess, 3.5);
    tick(0.82, '음량 고르기'); if (on('comp')) y = compress(y, sr, -26, p.ratio, 0.006, 0.14, 6);
    tick(0.92, '라우드니스');
    if (on('norm')) {
      const cur = lufs(y, sr);
      if (cur > -70) { const g = Math.pow(10, (targetLufs - cur) / 20); for (let i = 0; i < y.length; i++) y[i] *= g; }
    }
    tick(0.97, '피크 제한');   if (on('limit')) y = limit(y, sr, ceilDb);
    tick(1, '완료');
    return { pcm: y, before: before, after: measure(y, sr) };
  }

  // 16bit PCM WAV
  function toWav(pcm, sr) {
    const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++, o += 2) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); }
    return buf;
  }

  const api = { polish: polish, measure: measure, lufs: lufs, toWav: toWav, PRESETS: PRESETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.VoicePolish = api;
})(typeof window !== 'undefined' ? window : globalThis);
