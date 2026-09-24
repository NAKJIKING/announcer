#!/usr/bin/env python3
"""녹음한 목소리를 방송용으로 다듬는다 (아나운서 후처리 체인).

  python voice_polish.py 입력.m4a -o 출력.wav [--preset natural|broadcast|warm] [--report]

측정 → 처리 → 재측정 순으로 돌아간다. 귀로 확인할 수 없는 환경에서도 결과를
숫자로 검증할 수 있게, 처리 전후 지표를 같이 뽑는다.

체인 (순서가 중요하다):
  1. DC 제거 · 하이패스        마이크 진동·에어컨 같은 초저역 제거
  2. 스펙트럼 노이즈 게이트     무음 구간에서 잡음 프로파일을 떠서 빼낸다
  3. 정적 EQ                  탁한 저중역 정리 + 또렷함(프레즌스) + 공기감
  4. 디에서                   ㅅ·ㅊ 치찰음이 튀는 구간만 동적으로 누른다
  5. 컴프레서                 들쭉날쭉한 음량을 고르게
  6. 라우드니스 정규화          방송/팟캐스트 기준(-16 LUFS)에 맞춤
  7. 트루피크 리미터           -1 dBTP 를 넘지 않게

ITU-R BS.1770-4 의 K-weighting 라우드니스를 직접 구현했다(pyloudnorm 없이 동작).
"""
import argparse, sys
import numpy as np
from scipy import signal
import soundfile as sf

# ───────────────────────── 측정 ─────────────────────────
def _k_weight(x, sr):
    """BS.1770 K-weighting: 헤드 쉘프 + 하이패스"""
    # stage 1: high-shelf (+4dB @ ~1.5kHz)
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = np.array([(Vh + Vb * K / Q + K * K), 2 * (K * K - Vh), (Vh - Vb * K / Q + K * K)]) / a0
    a = np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    y = signal.lfilter(b, a, x)
    # stage 2: high-pass (~38Hz)
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr)
    a0 = 1 + K / Q + K * K
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return signal.lfilter(b2, a2, y)

def lufs(x, sr):
    """게이팅 적용 통합 라우드니스 (BS.1770-4)"""
    y = _k_weight(x, sr)
    bs, hop = int(0.4 * sr), int(0.1 * sr)          # 400ms 블록, 75% 겹침
    if len(y) < bs: return -70.0
    blocks = np.array([np.mean(y[i:i + bs] ** 2) for i in range(0, len(y) - bs + 1, hop)])
    with np.errstate(divide="ignore"):
        l = -0.691 + 10 * np.log10(np.maximum(blocks, 1e-20))
    sel = l > -70.0                                  # 절대 게이트
    if not sel.any(): return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(blocks[sel])) - 10.0   # 상대 게이트
    sel &= l > rel
    if not sel.any(): return -70.0
    return float(-0.691 + 10 * np.log10(np.mean(blocks[sel])))

def true_peak_db(x, sr, over=4):
    """오버샘플링해서 재는 트루피크 (샘플 사이 피크를 놓치지 않게)"""
    up = signal.resample_poly(x, over, 1)
    p = float(np.abs(up).max())
    return -120.0 if p <= 0 else 20 * np.log10(p)

def speech_mask(x, sr, frame=0.1):
    fr = int(frame * sr); n = len(x) // fr * fr
    if n == 0: return np.zeros(1, bool), fr
    F = x[:n].reshape(-1, fr)
    e = np.sqrt((F ** 2).mean(1) + 1e-20)
    edb = 20 * np.log10(e)
    return edb > (np.percentile(edb, 60) - 12), fr

def measure(x, sr, label):
    m, fr = speech_mask(x, sr)
    n = len(x) // fr * fr
    F = x[:n].reshape(-1, fr)
    edb = 20 * np.log10(np.sqrt((F ** 2).mean(1) + 1e-20))
    sp = edb[m] if m.any() else edb
    nz = edb[~m] if (~m).any() else edb
    d = dict(label=label,
             peak=20 * np.log10(max(np.abs(x).max(), 1e-12)),
             tp=true_peak_db(x, sr),
             lufs=lufs(x, sr),
             floor=float(np.median(nz)),
             speech=float(np.median(sp)),
             var=float(np.percentile(sp, 90) - np.percentile(sp, 10)))
    d["snr"] = d["speech"] - d["floor"]
    return d

def print_report(a, b=None):
    rows = [("피크", "peak", "dBFS"), ("트루피크", "tp", "dBTP"), ("라우드니스", "lufs", "LUFS"),
            ("노이즈 플로어", "floor", "dBFS"), ("신호대잡음", "snr", "dB"), ("음량 편차", "var", "dB")]
    if b is None:
        print(f"\n{a['label']}")
        for nm, k, u in rows: print(f"  {nm:12s} {a[k]:+7.1f} {u}")
        return
    print(f"\n{'':14s} {'처리 전':>10s} {'처리 후':>10s}")
    for nm, k, u in rows:
        print(f"  {nm:12s} {a[k]:+9.1f} {b[k]:+9.1f}  {u}")

# ───────────────────────── 처리 ─────────────────────────
def biquad_peak(x, sr, f0, gain_db, Q):
    A = 10 ** (gain_db / 40); w0 = 2 * np.pi * f0 / sr
    al = np.sin(w0) / (2 * Q); c = np.cos(w0)
    b = [1 + al * A, -2 * c, 1 - al * A]
    a = [1 + al / A, -2 * c, 1 - al / A]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x)

def biquad_shelf(x, sr, f0, gain_db, high=True, S=0.7):
    A = 10 ** (gain_db / 40); w0 = 2 * np.pi * f0 / sr
    c, s = np.cos(w0), np.sin(w0)
    al = s / 2 * np.sqrt((A + 1 / A) * (1 / S - 1) + 2)
    tsa = 2 * np.sqrt(A) * al
    if high:
        b = [A * ((A + 1) + (A - 1) * c + tsa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - tsa)]
        a = [(A + 1) - (A - 1) * c + tsa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - tsa]
    else:
        b = [A * ((A + 1) - (A - 1) * c + tsa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - tsa)]
        a = [(A + 1) + (A - 1) * c + tsa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - tsa]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x)

def denoise(x, sr, strength=1.0, nfft=2048):
    """스펙트럼 게이팅. 조용한 프레임에서 잡음 스펙트럼을 떠서 부드럽게 빼낸다.
       과하게 빼면 '물소리' 같은 인공음(musical noise)이 생기므로 바닥을 남긴다."""
    hop = nfft // 4; win = np.hanning(nfft)
    f, t, Z = signal.stft(x, sr, window=win, nperseg=nfft, noverlap=nfft - hop)
    mag, ph = np.abs(Z), np.angle(Z)
    fe = mag.mean(0)
    noise_frames = fe <= np.percentile(fe, 25)          # 조용한 25%
    if noise_frames.sum() < 4: return x
    prof = np.median(mag[:, noise_frames], axis=1, keepdims=True)
    # 감쇠량을 주파수마다 계산하되, 최대 감쇠를 제한해 자연스럽게
    over = 1.6 * strength
    gain = np.maximum(mag - over * prof, 0.0) / np.maximum(mag, 1e-12)
    floor_g = 10 ** (-14 * strength / 20)               # 바닥 -14dB 정도만
    gain = np.maximum(gain, floor_g)
    # 시간·주파수 평활 (인공음 억제)
    gain = signal.medfilt(gain, kernel_size=(3, 3))
    gain = signal.lfilter([0.35], [1, -0.65], gain, axis=1)
    _, y = signal.istft(gain * mag * np.exp(1j * ph), sr, window=win, nperseg=nfft, noverlap=nfft - hop)
    return y[:len(x)].astype(np.float32)

def deess(x, sr, thresh_db=-28.0, ratio=3.5, band=(5000, 9500)):
    """치찰음 대역만 따로 떼어, 그 대역이 셀 때만 눌러서 되섞는다."""
    sos = signal.butter(4, [band[0] / (sr / 2), min(0.99, band[1] / (sr / 2))], btype="band", output="sos")
    s = signal.sosfilt(sos, x)
    env = np.abs(signal.hilbert(s))
    env = signal.lfilter([0.02], [1, -0.98], env)       # 부드러운 포락선
    edb = 20 * np.log10(np.maximum(env, 1e-9))
    over = np.maximum(edb - thresh_db, 0)
    red_db = -over * (1 - 1 / ratio)
    g = 10 ** (red_db / 20)
    return (x - s + s * g).astype(np.float32)

def compress(x, sr, thresh_db=-26.0, ratio=3.0, attack=0.006, release=0.14, knee_db=6.0):
    env = np.abs(signal.hilbert(x))
    aa, ar = np.exp(-1 / (attack * sr)), np.exp(-1 / (release * sr))
    e = np.empty_like(env); prev = env[0]
    for i, v in enumerate(env):                          # 어택/릴리즈가 다른 포락선 추종
        co = aa if v > prev else ar
        prev = co * prev + (1 - co) * v; e[i] = prev
    edb = 20 * np.log10(np.maximum(e, 1e-9))
    over = edb - thresh_db
    red = np.where(over <= -knee_db / 2, 0.0,
          np.where(over >= knee_db / 2, over * (1 - 1 / ratio),
                   (1 - 1 / ratio) * (over + knee_db / 2) ** 2 / (2 * knee_db)))
    return (x * 10 ** (-red / 20)).astype(np.float32)

def limit(x, sr, ceil_db=-1.0, over=4):
    """오버샘플링 기반 트루피크 리미터"""
    ceil = 10 ** (ceil_db / 20)
    up = signal.resample_poly(x, over, 1)
    env = np.abs(up)
    w = int(0.002 * sr * over) | 1
    env = signal.maximum_filter1d(env, w) if hasattr(signal, "maximum_filter1d") else env
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    env = maximum_filter1d(np.abs(up), w)
    env = uniform_filter1d(env, w)
    g = np.minimum(1.0, ceil / np.maximum(env, 1e-9))
    y = signal.resample_poly(up * g, 1, over)[:len(x)]
    p = np.abs(y).max()
    if p > ceil: y = y * (ceil / p)
    return y.astype(np.float32)

PRESETS = {
    # (하이패스, 머드컷dB, 프레즌스dB, 에어dB, 디에서threshold, 컴프ratio, 노이즈강도)
    "natural":   dict(hp=70, mud=-2.5, pres=2.5, air=1.5, deess=-26, ratio=2.5, nr=0.7),
    "broadcast": dict(hp=80, mud=-4.0, pres=4.5, air=3.0, deess=-28, ratio=3.2, nr=1.0),
    "warm":      dict(hp=65, mud=-1.5, pres=2.0, air=1.0, deess=-25, ratio=2.8, nr=0.8),
}

def polish(x, sr, preset="broadcast", target_lufs=-16.0, ceil_db=-1.0):
    p = PRESETS[preset]
    y = x - x.mean()
    sos = signal.butter(3, p["hp"] / (sr / 2), btype="high", output="sos")
    y = signal.sosfilt(sos, y)
    y = denoise(y, sr, strength=p["nr"])
    y = biquad_peak(y, sr, 260, p["mud"], 1.1)          # 탁함 정리
    y = biquad_peak(y, sr, 3400, p["pres"], 0.9)        # 또렷함
    y = biquad_shelf(y, sr, 9500, p["air"], high=True)  # 공기감
    y = deess(y, sr, thresh_db=p["deess"])
    y = compress(y, sr, ratio=p["ratio"])
    cur = lufs(y, sr)
    if cur > -70: y = y * 10 ** ((target_lufs - cur) / 20)
    y = limit(y, sr, ceil_db=ceil_db)
    return y.astype(np.float32)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input"); ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--preset", default="broadcast", choices=list(PRESETS))
    ap.add_argument("--lufs", type=float, default=-16.0)
    ap.add_argument("--ceil", type=float, default=-1.0)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    x, sr = sf.read(a.input, dtype="float32")
    if x.ndim > 1: x = x.mean(1)
    before = measure(x, sr, "처리 전")
    y = polish(x, sr, a.preset, a.lufs, a.ceil)
    after = measure(y, sr, f"처리 후 ({a.preset})")
    sf.write(a.output, y, sr, subtype="PCM_16")
    if a.report: print_report(before, after)
    print(f"\n저장: {a.output}  ({len(y)/sr:.1f}s, {sr}Hz)")

if __name__ == "__main__":
    main()
