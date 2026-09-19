/* 아나운서 · 온디바이스 신경망 TTS 엔진 (Supertonic 3, 브라우저)
 *
 * 이 파일은 supertone-oss-archive/supertonic 의 web/helper.js 를 포팅·수정한 것이다.
 * (번들러 없는 고전 스크립트로 바꾸고, 중첩 배열 대신 typed array 를 쓰도록 다시 썼다.)
 * 원본 코드의 라이선스 고지를 아래에 그대로 싣는다.
 *
 * ── 원본 고지 (MIT) ────────────────────────────────────────────────────────
 *   MIT License
 *
 *   Copyright (c) 2025 Supertone Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 전역 `ort` (onnxruntime-web, MIT) 가 먼저 로드돼 있어야 한다.
 *
 *  - 모델 가중치: OpenRAIL-M (Supertone Inc.) — models/supertonic-3/LICENSE 참고
 *  - 파이프라인: text → unicode ids → duration_predictor → text_encoder → vector_estimator(×steps) → vocoder → 44.1kHz PCM
 *  - 저장: Cache API (캐시 이름 announcer-models-*). sw.js 는 이 접두사를 지우지 않는다.
 *  - http(s) 에서만 동작한다 (file:// 에서는 Cache API·WASM 로딩 불가).
 */
(function (global) {
  'use strict';

  const LANGS = ['en','ko','ja','ar','bg','cs','da','de','el','es','et','fi','fr','hi','hr','hu','id','it','lt','lv','nl','pl','pt','ro','ru','sk','sl','sv','tr','uk','vi','na'];
  const DEFAULTS = { steps: 8, speed: 1.05, silence: 0.3, cacheName: 'announcer-models-v1' };
  const STYLE_NAMES = ['M1','M2','M3','M4','M5','F1','F2','F3','F4','F5'];

  // 기본 매니페스트: 같은 오리진 models/ 에 manifest.json 이 없을 때(허깅페이스 직접 로드) 쓰는 파일 목록
  const MODEL_KEYS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
  const META_FILES = ['onnx/tts.json', 'onnx/unicode_indexer.json'];
  const DEFAULT_MODEL_FILES = MODEL_KEYS.reduce((o, k) => (o[k] = 'onnx/' + k + '.onnx', o), {});
  const SHORT = { duration_predictor: 'dp', text_encoder: 'te', vector_estimator: 've', vocoder: 'voc' };

  // ─────────────────────────── 텍스트 전처리 (원본 helper.js 와 동일 규칙) ───────────────────────────
  const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
  const REPL = [['–','-'],['‑','-'],['—','-'],['_',' '],['“','"'],['”','"'],['‘',"'"],['’',"'"],['´',"'"],['`',"'"],
    ['[',' '],[']',' '],['|',' '],['/',' '],['#',' '],['→',' '],['←',' ']];
  const EXPR = [['@',' at '],['e.g.,','for example, '],['i.e.,','that is, ']];

  function preprocessText(text, lang) {
    if (!LANGS.includes(lang)) throw new Error('지원하지 않는 언어: ' + lang);
    text = String(text).normalize('NFKD').replace(EMOJI_RE, '');
    for (const [k, v] of REPL) text = text.split(k).join(v);
    text = text.replace(/[♥☆♡©\\]/g, '');
    for (const [k, v] of EXPR) text = text.split(k).join(v);
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?')
               .replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) text = '.';
    if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
    return '<' + lang + '>' + text + '</' + lang + '>';
  }

  // 문장 → 모델 입력 길이 제한(ko/ja 120자, 그 외 300자)에 맞춘 조각. 원본은 긴 문장을 그대로 넘기지만
  // 여기서는 쉼표·공백에서 한 번 더 잘라 상한을 반드시 지킨다.
  function chunkText(text, maxLen) {
    const out = [];
    const paras = String(text).trim().split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
    for (const para of paras) {
      const sents = para.split(/(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|Inc|Ltd|Co|Corp|St)\.)(?<!\b[A-Z]\.)(?<=[.!?…。])\s+/).map(s => s.trim()).filter(Boolean);
      let cur = '';
      for (const s0 of sents) {
        const pieces = s0.length <= maxLen ? [s0] : hardSplit(s0, maxLen);
        for (const s of pieces) {
          if (cur && cur.length + 1 + s.length > maxLen) { out.push(cur); cur = s; }
          else cur = cur ? cur + ' ' + s : s;
        }
      }
      if (cur) out.push(cur);
    }
    return out.length ? out : [String(text).trim()];
  }
  function hardSplit(s, maxLen) {
    const res = [];
    let parts = s.split(/(?<=[,，、;；:：])\s*/).filter(Boolean);
    let cur = '';
    const flush = () => { if (cur) { res.push(cur); cur = ''; } };
    for (let p of parts) {
      if (p.length > maxLen) {                     // 쉼표도 없는 긴 덩어리 → 공백 단위
        flush();
        let w = '';
        for (const tok of p.split(/\s+/)) {
          if (w && w.length + 1 + tok.length > maxLen) { res.push(w); w = tok; }
          else w = w ? w + ' ' + tok : tok;
          while (w.length > maxLen) { res.push(w.slice(0, maxLen)); w = w.slice(maxLen); } // 공백조차 없는 경우
        }
        if (w) res.push(w);
        continue;
      }
      if (cur && cur.length + 1 + p.length > maxLen) { flush(); cur = p; }
      else cur = cur ? cur + ' ' + p : p;
    }
    flush();
    return res;
  }

  class UnicodeIndexer {
    constructor(indexer) { this.indexer = indexer; }
    // 단일 문장용 (배치는 쓰지 않는다): ids [1,T] int64, mask [1,1,T] float32
    encode(text, lang) {
      const chars = Array.from(preprocessText(text, lang));
      const T = chars.length;
      const ids = new BigInt64Array(T);
      for (let i = 0; i < T; i++) {
        const cp = chars[i].codePointAt(0);
        ids[i] = BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
      }
      const mask = new Float32Array(T).fill(1);
      return { ids, mask, T };
    }
  }

  // ─────────────────────────── 목소리 스타일 ───────────────────────────
  class VoiceStyle {
    constructor(ttl, ttlDims, dp, dpDims, meta) {
      this.ttl = ttl; this.ttlDims = ttlDims; this.dp = dp; this.dpDims = dpDims; this.meta = meta || {};
    }
    static fromJSON(obj, meta) {
      const flat = (a) => { const out = []; (function rec(x) { Array.isArray(x) ? x.forEach(rec) : out.push(x); })(a); return Float32Array.from(out); };
      return new VoiceStyle(flat(obj.style_ttl.data), obj.style_ttl.dims.slice(), flat(obj.style_dp.data), obj.style_dp.dims.slice(), meta);
    }
    toJSON() {
      const nest = (arr, dims) => { let i = 0; const rec = (d) => d === dims.length - 1 ? Array.from(arr.subarray(i, i += dims[d])) : Array.from({ length: dims[d] }, () => rec(d + 1)); return rec(0); };
      return { style_ttl: { dims: this.ttlDims, data: nest(this.ttl, this.ttlDims) }, style_dp: { dims: this.dpDims, data: nest(this.dp, this.dpDims) } };
    }
    // 볼록 결합(가중치 합 1)으로 새 목소리를 만든다 — Voice Mixer 커뮤니티 도구와 같은 방식
    static mix(styles, weights) {
      if (!styles.length) throw new Error('mix: 스타일이 없습니다');
      const w = weights ? weights.slice() : styles.map(() => 1);
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < w.length; i++) w[i] /= sum;
      const ttl = new Float32Array(styles[0].ttl.length), dp = new Float32Array(styles[0].dp.length);
      styles.forEach((s, i) => {
        if (s.ttl.length !== ttl.length || s.dp.length !== dp.length) throw new Error('mix: 스타일 차원이 다릅니다');
        for (let k = 0; k < ttl.length; k++) ttl[k] += s.ttl[k] * w[i];
        for (let k = 0; k < dp.length; k++) dp[k] += s.dp[k] * w[i];
      });
      return new VoiceStyle(ttl, styles[0].ttlDims.slice(), dp, styles[0].dpDims.slice(), { mixed: styles.map((s, i) => [s.meta.name || '?', +w[i].toFixed(3)]) });
    }
    // 음색(ttl)만 살짝 흔들어 변주를 만든다 (amount 0.05~0.2 권장)
    static perturb(style, amount, seed) {
      const rnd = mulberry32(seed == null ? 1234 : seed);
      const ttl = new Float32Array(style.ttl.length);
      let scale = 0; for (let k = 0; k < ttl.length; k++) scale = Math.max(scale, Math.abs(style.ttl[k]));
      for (let k = 0; k < ttl.length; k++) ttl[k] = style.ttl[k] + (rnd() * 2 - 1) * amount * scale;
      return new VoiceStyle(ttl, style.ttlDims.slice(), style.dp.slice(), style.dpDims.slice(), { perturbed: [style.meta.name || '?', amount, seed] });
    }
    // proxy 워커 모드에서는 입력 버퍼가 워커로 transfer 되어 detach 되므로, 호출마다 새 복사본을 만든다
    tensors() {
      return { ttl: new global.ort.Tensor('float32', this.ttl.slice(), this.ttlDims.slice()), dp: new global.ort.Tensor('float32', this.dp.slice(), this.dpDims.slice()) };
    }
  }

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ─────────────────────────── 모델 저장소 (Cache API) ───────────────────────────
  class ModelStore {
    constructor(cacheName) { this.cacheName = cacheName || DEFAULTS.cacheName; }
    static available() { return typeof caches !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'); }
    key(name, file) { return location.origin + '/__models/' + name + '/' + file; }
    async _cache() { return caches.open(this.cacheName); }
    async has(name, file) { const c = await this._cache(); return !!(await c.match(this.key(name, file))); }
    async get(name, file) { const c = await this._cache(); const r = await c.match(this.key(name, file)); return r ? r.arrayBuffer() : null; }
    async put(name, file, buf) {
      const c = await this._cache();
      await c.put(this.key(name, file), new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) } }));
    }
    async list(name) { const c = await this._cache(); const keys = await c.keys(); const pre = this.key(name, ''); return keys.map(r => r.url).filter(u => u.startsWith(pre)).map(u => u.slice(pre.length)); }
    async clear(name) { const c = await this._cache(); for (const f of await this.list(name)) await c.delete(this.key(name, f)); }
    async estimate() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; } }
    async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } }
  }

  async function verifySha256(buf, expect) {
    try {
      if (!(global.crypto && global.crypto.subtle)) return true;   // 구형 환경에서는 크기 검사만
      const d = await global.crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
      return hex === String(expect).toLowerCase();
    } catch (e) { return true; }
  }

  async function fetchBytes(url, { onProgress, signal, expectedSize } = {}) {
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error('다운로드 실패 ' + res.status + ' ' + url);
    const total = expectedSize || Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); onProgress && onProgress(b.byteLength, b.byteLength); return b; }
    const reader = res.body.getReader();
    let received = 0, buf = total ? new Uint8Array(total) : null, parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (buf) { if (received + value.length > buf.length) { const g = new Uint8Array(received + value.length); g.set(buf.subarray(0, received)); buf = g; } buf.set(value, received); }
      else parts.push(value);
      received += value.length;
      onProgress && onProgress(received, total);
    }
    if (buf) return buf.byteLength === received ? buf.buffer : buf.buffer.slice(0, received);
    const out = new Uint8Array(received); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }

  // ─────────────────────────── 엔진 ───────────────────────────
  class SupertonicEngine {
    /**
     * @param {object} o
     * @param {string[]} o.bases     모델 베이스 URL 목록(우선순위 순). 예: ['models/supertonic-3/', 'https://huggingface.co/.../resolve/<rev>/']
     * @param {string}   o.ortBase   onnxruntime-web 의 .wasm/.mjs 가 있는 디렉터리 URL
     * @param {string}   [o.name]    캐시 키 이름 (기본 supertonic-3)
     * @param {string}   [o.cacheName]
     */
    constructor(o) {
      this.bases = (o.bases || []).map(b => b.endsWith('/') ? b : b + '/');
      this.ortBase = o.ortBase;
      this.name = o.name || 'supertonic-3';
      this.variant = o.variant || 'auto';       // 'auto' | 'fp32' | 'int8' — int8 은 CPU(wasm) 용, WebGPU 는 fp32
      this.store = new ModelStore(o.cacheName);
      this.manifest = null; this.cfg = null; this.indexer = null;
      this.sessions = null; this.provider = null;
      this.styles = new Map();
      this.sampleRate = 44100;
    }
    static support() {
      return {
        wasm: typeof WebAssembly !== 'undefined',
        webgpu: !!(global.navigator && navigator.gpu),
        storage: ModelStore.available(),
        ort: !!global.ort,
      };
    }
    get ort() { if (!global.ort) throw new Error('onnxruntime-web(ort) 가 로드되지 않았습니다'); return global.ort; }

    async _manifest() {
      if (this.manifest) return this.manifest;
      for (const base of this.bases) {
        try {
          const r = await fetch(base + 'manifest.json', { cache: 'no-store' });
          if (r.ok) { const m = await r.json(); m._base = base; this.manifest = m; return m; }
        } catch (e) { /* 다음 베이스 */ }
      }
      // 매니페스트 없음 → 기본 파일 목록으로 구성 (크기 미상)
      const files = {}; META_FILES.concat(Object.values(DEFAULT_MODEL_FILES)).forEach(f => files[f] = {});
      STYLE_NAMES.forEach(s => files['voice_styles/' + s + '.json'] = {});
      this.manifest = { name: this.name, files, styles: STYLE_NAMES.slice(), _base: this.bases[0] || '' };
      return this.manifest;
    }
    // 실제로 쓸 변형: 매니페스트에 variants 가 있으면 그 안에서, 없으면 fp32 단일 파일
    async resolveVariant() {
      const m = await this._manifest();
      if (this._variant) return this._variant;
      let v = this.variant;
      if (v === 'auto') {
        let gpuOK = false;
        if (navigator.gpu) { try { gpuOK = !!(await navigator.gpu.requestAdapter()); } catch (e) {} }
        v = gpuOK ? 'fp32' : 'int8';
      }
      if (!(m.variants && m.variants[v])) v = (m.variants && m.variants.fp32) ? 'fp32' : 'default';
      this._variant = v;
      return v;
    }
    /* 네 모델의 실제 파일 경로. 매니페스트의 variants[변형] 은 모델 이름을 키로 갖는다
       (tools/mirror_models.py 가 그렇게 쓴다). 예전처럼 vector_estimator 하나만 변형에서
       찾으면 int8 배포본에서 나머지 세 모델을 fp32 이름으로 요청해 전부 404 가 난다. */
    async modelFiles() {
      const m = await this._manifest(); const v = await this.resolveVariant();
      const vm = (m.variants && m.variants[v]) || null;
      const out = {};
      for (const k of MODEL_KEYS) {
        out[k] = (vm && (vm[k] || vm[SHORT[k]])) || DEFAULT_MODEL_FILES[k];
      }
      return out;
    }
    async requiredFiles() {
      const m = await this._manifest();
      const mf = await this.modelFiles();
      return META_FILES.concat(MODEL_KEYS.map(k => mf[k]),
        (m.styles || STYLE_NAMES).map(s => 'voice_styles/' + s + '.json'));
    }
    async info() {
      const m = await this._manifest();
      return { source: m.source, revision: m.revision, license: m.license, licenseFile: m.licenseFile,
               modifications: m.modifications, styles: (m.styles || STYLE_NAMES).length, base: m._base };
    }
    async isInstalled() {
      if (!ModelStore.available()) return false;
      for (const f of await this.requiredFiles()) if (!(await this.store.has(this.name, f))) return false;
      return true;
    }
    get installFailed() { return !!this._installFailed; }
    async installedBytes() {
      const m = await this._manifest(); let n = 0;
      for (const f of await this.requiredFiles()) if (await this.store.has(this.name, f)) n += ((m.files[f] || {}).size || 0);
      return n;
    }
    async totalBytes() { const m = await this._manifest(); return (await this.requiredFiles()).reduce((a, f) => a + ((m.files[f] || {}).size || 0), 0); }

    // 파일 하나 확보: 캐시 → (부분 파일 포함) 다운로드 → 캐시 저장
    async _file(file, { onProgress, signal } = {}) {
      const cached = await this.store.get(this.name, file);
      if (cached) { onProgress && onProgress(file, cached.byteLength, cached.byteLength, true); return cached; }
      const m = await this._manifest();
      const meta = m.files[file] || {};
      const parts = meta.parts && meta.parts.length ? meta.parts : [file];
      let buf = null;
      let lastErr = null;
      for (const base of this.bases.length ? this.bases : [m._base]) {
        try {
          const chunks = [];
          let got = 0;
          for (const p of parts) {
            const b = await fetchBytes(base + p, { signal, expectedSize: parts.length === 1 ? meta.size : undefined,
              onProgress: (r) => onProgress && onProgress(file, got + r, meta.size || 0, false) });
            chunks.push(new Uint8Array(b)); got += b.byteLength;
          }
          if (chunks.length === 1) buf = chunks[0].buffer;
          else { const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } buf = out.buffer; }
          break;
        } catch (e) { lastErr = e; if (signal && signal.aborted) throw e; }
      }
      if (!buf) throw lastErr || new Error('모델 파일을 받을 수 없습니다: ' + file);
      if (meta.size && buf.byteLength !== meta.size) throw new Error('파일 크기가 매니페스트와 다릅니다: ' + file);
      if (meta.sha256) {                       // 매니페스트에 적어 둔 해시를 실제로 확인한다
        const ok = await verifySha256(buf, meta.sha256);
        if (!ok) throw new Error('모델 파일이 손상되었습니다 (해시 불일치): ' + file);
      }
      try { await this.store.put(this.name, file, buf); }
      catch (e) {                       // 용량 초과·프라이빗 모드 등: 조용히 넘기면 매번 다시 받게 된다
        this._installFailed = e;
        console.warn('모델 캐시 저장 실패', file, e);
      }
      return buf;
    }

    // 모든 파일을 내려받아 캐시에 둔다 (세션은 만들지 않음). 진행률: {file, received, total, done, overallReceived, overallTotal}
    async install({ onProgress, signal } = {}) {
      if (!ModelStore.available()) throw new Error('이 환경에서는 모델을 저장할 수 없습니다 (https 필요)');
      this._installFailed = null;
      await this.store.persist();
      const m = await this._manifest();
      const files = await this.requiredFiles();
      const overallTotal = files.reduce((a, f) => a + ((m.files[f] || {}).size || 0), 0);
      let doneBytes = 0;
      for (const f of files) {
        const sz = (m.files[f] || {}).size || 0;
        await this._file(f, { signal, onProgress: (file, r, t, fromCache) => onProgress && onProgress({ file, received: r, total: t, fromCache, overallReceived: doneBytes + Math.min(r, sz || r), overallTotal }) });
        doneBytes += sz;
      }
      if (this._installFailed) {
        const e = new Error('모델을 기기에 저장하지 못했습니다 (저장 공간이 부족할 수 있습니다). 이번 세션에서는 쓸 수 있지만, 앱을 다시 열면 다시 받아야 합니다.');
        e.name = 'StorageError'; e.cause = this._installFailed; throw e;
      }
      return true;
    }
    async uninstall() { await this.store.clear(this.name); this.dispose(); }

    // 세션 준비. prefer: 'auto' | 'webgpu' | 'wasm'
    async load({ prefer = 'auto', onProgress, signal, proxy } = {}) {
      if (this.sessions) return this.provider;
      const ort = this.ort;
      const m = await this._manifest();
      const stage = (s, i, n) => onProgress && onProgress({ stage: s, index: i, count: n });
      stage('config', 0, 6);
      const cfgBuf = await this._file('onnx/tts.json', { signal });
      this.cfg = JSON.parse(new TextDecoder().decode(cfgBuf));
      this.sampleRate = this.cfg.ae.sample_rate;
      stage('indexer', 1, 6);
      this.indexer = new UnicodeIndexer(JSON.parse(new TextDecoder().decode(await this._file('onnx/unicode_indexer.json', { signal }))));

      // 실행 제공자 순서: WebGPU 어댑터가 실제로 잡히는 기기만 webgpu 를 먼저 시도한다
      let order;
      if (prefer === 'wasm') order = ['wasm'];
      else if (prefer === 'webgpu') order = ['webgpu'];
      else {
        let gpuOK = false;
        if (navigator.gpu) { try { gpuOK = !!(await navigator.gpu.requestAdapter()); } catch (e) { gpuOK = false; } }
        order = gpuOK ? ['webgpu', 'wasm'] : ['wasm'];
      }
      // ort 의 wasm 환경(경로·스레드·proxy 워커)은 페이지에서 첫 세션을 만들기 전에 딱 한 번만 정할 수 있다
      if (!global.__announcerOrtInit) {
        if (this.ortBase) {                       // ort 는 .mjs 를 동적 import 하므로 절대 URL 이어야 한다
          const abs = new URL(this.ortBase, location.href).href;
          ort.env.wasm.wasmPaths = abs.endsWith('/') ? abs : abs + '/';
        }
        ort.env.wasm.numThreads = (global.crossOriginIsolated && navigator.hardwareConcurrency) ? Math.min(4, navigator.hardwareConcurrency) : 1;
        // proxy 워커: CPU(wasm) 경로에서 UI 를 멈추지 않게 한다. WebGPU 는 워커 모드를 지원하지 않으므로 그때는 끈다.
        ort.env.wasm.proxy = (proxy !== undefined) ? !!proxy : order[0] === 'wasm';
        ort.env.logLevel = 'warning';
        global.__announcerOrtInit = { proxy: ort.env.wasm.proxy, order };
      }
      const mf = await this.modelFiles();
      const names = [['dp', mf.duration_predictor], ['te', mf.text_encoder], ['ve', mf.vector_estimator], ['voc', mf.vocoder]];
      const bufs = {};
      for (let i = 0; i < names.length; i++) { stage('download:' + names[i][0], 2 + i, 6); bufs[names[i][0]] = await this._file(names[i][1], { signal, onProgress: (f, r, t) => onProgress && onProgress({ stage: 'download:' + names[i][0], file: f, received: r, total: t }) }); }

      const variant = await this.resolveVariant();
      if (variant === 'int8' && order[0] === 'webgpu') order = ['wasm'];
      let lastErr = null;
      for (const ep of order) {
        try {
          const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
          const s = {};
          for (const [k] of names) { stage('session:' + k + ':' + ep, 0, 0); s[k] = await ort.InferenceSession.create(new Uint8Array(bufs[k]), opts); }
          this.sessions = s; this.provider = ep;
          break;
        } catch (e) { lastErr = e; console.warn('세션 생성 실패 (' + ep + ')', e); }
      }
      if (!this.sessions) throw lastErr || new Error('추론 세션을 만들 수 없습니다');
      this.variantUsed = variant;
      return this.provider;
    }

    async loadStyle(nameOrJSON) {
      if (nameOrJSON instanceof VoiceStyle) return nameOrJSON;
      if (typeof nameOrJSON === 'object') return VoiceStyle.fromJSON(nameOrJSON, { name: nameOrJSON.name || 'custom' });
      if (this.styles.has(nameOrJSON)) return this.styles.get(nameOrJSON);
      const buf = await this._file('voice_styles/' + nameOrJSON + '.json');
      const st = VoiceStyle.fromJSON(JSON.parse(new TextDecoder().decode(buf)), { name: nameOrJSON });
      this.styles.set(nameOrJSON, st);
      return st;
    }

    async _data(t) { const d = (typeof t.getData === 'function') ? await t.getData() : t.data; return d; }

    async _infer(text, lang, style, steps, speed, onStep, signal, rnd) {
      const ort = this.ort, S = this.sessions;
      const enc = this.indexer.encode(text, lang);
      // 모든 입력 텐서는 run() 마다 새로 만든다 (proxy 워커 transfer 로 detach 되기 때문)
      const textIds = () => new ort.Tensor('int64', enc.ids.slice(), [1, enc.T]);
      const textMask = () => new ort.Tensor('float32', enc.mask.slice(), [1, 1, enc.T]);

      const dpOut = await S.dp.run({ text_ids: textIds(), style_dp: style.tensors().dp, text_mask: textMask() });
      let dur = Number((await this._data(dpOut.duration))[0]) / speed;
      if (!(dur > 0.05)) dur = 0.05;
      if (signal && signal.aborted) throw abortError();

      const teOut = await S.te.run({ text_ids: textIds(), style_ttl: style.tensors().ttl, text_mask: textMask() });
      const embData = await this._data(teOut.text_emb); const embDims = teOut.text_emb.dims.slice();
      const textEmb = () => new ort.Tensor('float32', (embData instanceof Float32Array ? embData : Float32Array.from(embData)).slice(), embDims);
      if (teOut.text_emb.dispose) try { teOut.text_emb.dispose(); } catch (e) {}

      const sr = this.sampleRate;
      const chunk = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
      const D = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
      const wavLen = Math.floor(dur * sr);
      const L = Math.max(1, Math.ceil(wavLen / chunk));
      let xt = new Float32Array(D * L);
      const r = rnd || Math.random;
      for (let i = 0; i < xt.length; i++) { const u1 = Math.max(1e-4, r()), u2 = r(); xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }
      const latentMask = () => new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
      const totalStep = () => new ort.Tensor('float32', new Float32Array([steps]), [1]);

      for (let step = 0; step < steps; step++) {
        if (signal && signal.aborted) throw abortError();
        onStep && onStep(step + 1, steps);
        const out = await S.ve.run({
          noisy_latent: new ort.Tensor('float32', xt.slice(), [1, D, L]), text_emb: textEmb(), style_ttl: style.tensors().ttl,
          latent_mask: latentMask(), text_mask: textMask(),
          current_step: new ort.Tensor('float32', new Float32Array([step]), [1]), total_step: totalStep(),
        });
        const d = await this._data(out.denoised_latent);
        xt = (d instanceof Float32Array) ? d.slice() : Float32Array.from(d);
        if (out.denoised_latent.dispose) try { out.denoised_latent.dispose(); } catch (e) {}
      }
      const voc = await S.voc.run({ latent: new ort.Tensor('float32', xt.slice(), [1, D, L]) });
      const wav = await this._data(voc.wav_tts);
      const n = Math.min(wavLen, wav.length);
      const pcm = (wav instanceof Float32Array ? wav : Float32Array.from(wav)).slice(0, n);
      if (voc.wav_tts.dispose) try { voc.wav_tts.dispose(); } catch (e) {}
      return { pcm, duration: n / sr };
    }

    /**
     * 텍스트 전체를 합성한다. 조각마다 onChunk(pcm, i, n, meta) 를 불러 스트리밍 재생이 가능하다.
     * @returns {Promise<{pcm: Float32Array, sampleRate: number, duration: number, chunks: number, provider: string}>}
     */
    async synthesize(text, { lang = 'ko', style, steps = DEFAULTS.steps, speed = DEFAULTS.speed, silence = DEFAULTS.silence, onChunk, onProgress, signal, seed, concat = true } = {}) {
      if (!this.sessions) await this.load({ signal });
      if (!LANGS.includes(lang)) lang = 'na';
      const st = await this.loadStyle(style || 'F3');
      const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
      const pieces = chunkText(text, maxLen);
      const rnd = seed == null ? null : mulberry32(seed);
      const sr = this.sampleRate, gap = Math.floor(silence * sr);
      const outs = []; let total = 0;
      for (let i = 0; i < pieces.length; i++) {
        onProgress && onProgress({ chunk: i + 1, chunks: pieces.length, step: 0, steps, text: pieces[i] });
        const { pcm } = await this._infer(pieces[i], lang, st, steps, speed,
          (s, n) => onProgress && onProgress({ chunk: i + 1, chunks: pieces.length, step: s, steps: n, text: pieces[i] }), signal, rnd);
        if (concat) outs.push(pcm);
        total += pcm.length + (i < pieces.length - 1 ? gap : 0);
        onChunk && await onChunk(pcm, i, pieces.length, { text: pieces[i], sampleRate: sr });
      }
      // concat:false — 호출자가 조각을 직접 모으는 경우(긴 글 모드) 전체 사본을 만들지 않는다
      if (!concat) return { pcm: null, sampleRate: sr, duration: total / sr, chunks: pieces.length, provider: this.provider };
      const pcm = new Float32Array(total); let o = 0;
      outs.forEach((p, i) => { pcm.set(p, o); o += p.length + (i < outs.length - 1 ? gap : 0); });
      return { pcm, sampleRate: sr, duration: total / sr, chunks: pieces.length, provider: this.provider };
    }

    dispose() {
      if (this.sessions) for (const k of Object.keys(this.sessions)) try { this.sessions[k].release && this.sessions[k].release(); } catch (e) {}
      this.sessions = null; this.provider = null;
    }
  }

  function abortError() { const e = new Error('중단됨'); e.name = 'AbortError'; return e; }

  // 16-bit PCM WAV (모노)
  function writeWav(pcm, sampleRate) {
    const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44; for (let i = 0; i < n; i++, o += 2) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); }
    return buf;
  }

  global.Supertonic = { SupertonicEngine, VoiceStyle, ModelStore, UnicodeIndexer, preprocessText, chunkText, writeWav, LANGS, STYLE_NAMES, DEFAULTS, mulberry32 };
})(typeof window !== 'undefined' ? window : globalThis);
