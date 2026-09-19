#!/usr/bin/env python3
"""Supertonic 3 가중치를 허깅페이스 아카이브에서 받아 GitHub Pages 용으로 정리한다 (GitHub Actions 에서 실행).

  - 핀 고정된 리비전을 내려받는다 (아카이브 조직: supertone-oss-archive/supertonic-3)
  - 네 모델 전부를 동적 int8 양자화한다 (fp32 약 404MB → int8 약 110MB). 기본은 int8 만 커밋한다.
  - 90MB 를 넘는 파일은 .partN 으로 쪼갠다 (GitHub 100MB 파일 제한, Pages 는 LFS 를 서빙하지 않음)
  - manifest.json (크기·sha256·조각·변형) 과 LICENSE 를 함께 둔다

사용: python mirror_models.py --out models/supertonic-3 [--revision <sha>] [--no-int8]
"""
import argparse, hashlib, json, os, shutil, sys

REPO = "supertone-oss-archive/supertonic-3"
REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46"   # README 의 아카이브 스냅샷 핀
STYLES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
PART = 90 * 1024 * 1024

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); ap.add_argument("--revision", default=REVISION); ap.add_argument("--no-int8", action="store_true"); ap.add_argument("--keep-fp32", action="store_true", help="fp32 원본도 남긴다 (저장소가 크게 늘어남)")
    a = ap.parse_args()
    from huggingface_hub import snapshot_download
    src = snapshot_download(REPO, revision=a.revision, allow_patterns=["onnx/*", "voice_styles/*", "LICENSE*", "README.md"])
    print("downloaded snapshot:", src)
    for root, _, files in os.walk(src):
        for f in files: print("  ", os.path.relpath(os.path.join(root, f), src), os.path.getsize(os.path.join(root, f)))

    out = a.out
    if os.path.isdir(out): shutil.rmtree(out)
    os.makedirs(os.path.join(out, "onnx")); os.makedirs(os.path.join(out, "voice_styles"))
    want = ["onnx/tts.json", "onnx/unicode_indexer.json", "onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vector_estimator.onnx", "onnx/vocoder.onnx"] + [f"voice_styles/{s}.json" for s in STYLES]
    for rel in want:
        p = os.path.join(src, rel)
        if not os.path.exists(p): sys.exit(f"missing in snapshot: {rel}")
        shutil.copy(p, os.path.join(out, rel))
    for lic in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
        if os.path.exists(os.path.join(src, lic)): shutil.copy(os.path.join(src, lic), os.path.join(out, "LICENSE")); break
    else:
        print("WARNING: no LICENSE file in snapshot")

    # 변형 세트: fp32(원본) / int8(동적 양자화). 폰은 int8, dGPU PC 는 fp32.
    # 404MB fp32 전체를 공개 저장소에 넣으면 Pages 1GB 한도와 파일당 100MB 제한에 걸리므로
    # 기본 배포는 int8 만 커밋하고 fp32 는 --keep-fp32 를 줬을 때만 남긴다.
    MODELS = ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"]
    # 변형 맵의 키는 모델 이름이다 — engine/supertonic-engine.js 의 MODEL_KEYS 와 반드시 같아야 한다.
    variants = {"fp32": {m: f"onnx/{m}.onnx" for m in MODELS}}
    if not a.no_int8:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        q8 = {}
        for m in MODELS:
            src_p = os.path.join(out, f"onnx/{m}.onnx")
            dst_p = os.path.join(out, f"onnx/{m}_int8.onnx")
            try:
                quantize_dynamic(src_p, dst_p, weight_type=QuantType.QInt8)
                print(f"int8 {m}: {os.path.getsize(src_p)} -> {os.path.getsize(dst_p)}")
                q8[m] = f"onnx/{m}_int8.onnx"
            except Exception as e:                      # 양자화가 실패한 모델은 fp32 원본을 그대로 쓴다
                print(f"int8 {m}: FAILED ({e}); falling back to fp32")
                if os.path.exists(dst_p): os.remove(dst_p)
                q8[m] = f"onnx/{m}.onnx"
        variants["int8"] = q8
    if not a.keep_fp32 and "int8" in variants:
        # int8 세트가 참조하지 않는 fp32 원본은 지운다 (저장소 용량)
        keep = set(variants["int8"].values())
        for m in MODELS:
            rel = f"onnx/{m}.onnx"
            if rel not in keep and os.path.exists(os.path.join(out, rel)):
                os.remove(os.path.join(out, rel)); print("dropped", rel)
        variants.pop("fp32", None)

    files = {}
    for root, _, fs in os.walk(out):
        for f in sorted(fs):
            p = os.path.join(root, f); rel = os.path.relpath(p, out).replace(os.sep, "/")
            if rel in ("manifest.json", "LICENSE"): continue
            size = os.path.getsize(p); entry = {"size": size, "sha256": sha256(p)}
            if size > PART:
                parts = []
                with open(p, "rb") as fh:
                    k = 0
                    while True:
                        chunk = fh.read(PART)
                        if not chunk: break
                        pp = f"{rel}.part{k}"; open(os.path.join(out, pp), "wb").write(chunk); parts.append(pp); k += 1
                os.remove(p); entry["parts"] = parts
            files[rel] = entry
    mods = ["onnxruntime quantize_dynamic QInt8 (int8 변형)"] if "int8" in variants else []
    if any("parts" in v for v in files.values()): mods.append("90MB 초과 파일을 .partN 으로 분할")
    manifest = {"name": "supertonic-3", "source": f"https://huggingface.co/{REPO}", "revision": a.revision,
                "license": "OpenRAIL-M (model weights, Supertone Inc.)", "licenseFile": "LICENSE",
                "codeLicense": "MIT (inference code, Supertone Inc.)",
                "modifications": mods,
                "sampleRate": 44100, "styles": STYLES, "variants": variants, "files": files}
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1, ensure_ascii=False)
    # 변경 사실과 사용 제한을 담은 고지 파일 (OpenRAIL-M 은 파생물 배포 시 고지를 요구한다)
    with open(os.path.join(out, "NOTICE.txt"), "w", encoding="utf-8") as f:
        f.write("Supertonic 3 model weights\n")
        f.write(f"Source : https://huggingface.co/{REPO}\n")
        f.write(f"Revision: {a.revision}\n")
        f.write("License : OpenRAIL-M (Supertone Inc.) — see LICENSE in this directory\n\n")
        f.write("Modifications made when mirroring:\n")
        for m in mods: f.write(f"  - {m}\n")
        if not mods: f.write("  - (none; files copied verbatim)\n")
        f.write("\nOpenRAIL-M use restrictions apply. In particular the model must not be used to\n"
                "impersonate a person without their consent, or to generate content presented as\n"
                "human-made without disclosure. See the LICENSE file for the full list.\n")
    total = sum(v["size"] for v in files.values())
    print(f"manifest written: {len(files)} files, {total/1e6:.1f} MB total")
    for k, v in files.items(): print(f"  {k:40s} {v['size']:>11d}" + (f"  parts={len(v['parts'])}" if "parts" in v else ""))

if __name__ == "__main__": main()
