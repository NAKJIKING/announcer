"""로컬 검증용 대체(stand-in) Supertonic 모델 세트를 만든다.

실제 가중치는 이 컨테이너에서 받을 수 없어(허깅페이스 차단), 입출력 이름·dtype·동적 차원만 같은
초경량 ONNX 그래프 4개와 tts.json / unicode_indexer.json / voice_styles/*.json 을 생성한다.
엔진 배관(텐서 규격, 분할 다운로드, 캐시, 청크 스트리밍, WAV 내보내기)을 검증하는 용도이며
음질 검증은 GitHub Actions 에서 실제 가중치로 수행한다.

차원 근거: Supertonic-qualcomm-quantized 의 QNN 그래프(style_ttl 50×256, style_dp 8×16,
latent 144차원, 프레임당 3072 샘플 = 512×6, 잠재 24×6).
"""
import json, os, sys, math, hashlib
import numpy as np
import onnx
from onnx import helper as H, TensorProto as TP

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/supertonic-3"
SR, BASE_CHUNK, COMPRESS, LATENT = 44100, 512, 6, 24
D = LATENT * COMPRESS          # 144
CHUNK = BASE_CHUNK * COMPRESS  # 3072 samples per latent frame
OPSET = 17
os.makedirs(f"{OUT}/onnx", exist_ok=True); os.makedirs(f"{OUT}/voice_styles", exist_ok=True)

def save(graph, name):
    m = H.make_model(graph, opset_imports=[H.make_opsetid("", OPSET)], producer_name="announcer-fixture")
    m.ir_version = 8
    onnx.checker.check_model(m)
    p = f"{OUT}/onnx/{name}.onnx"; onnx.save(m, p); return p

def const(name, arr, dtype=TP.FLOAT):
    return H.make_node("Constant", [], [name], value=H.make_tensor(name + "_v", dtype, list(np.shape(arr)), np.array(arr).flatten().tolist()))

# 1) duration_predictor: duration[B] = 0.085 s × (문자 수)  (text_mask 합)
g = H.make_graph([
    const("k", [0.085]),
    H.make_node("ReduceSum", ["text_mask", "axes12"], ["cnt"], keepdims=0),
    H.make_node("Mul", ["cnt", "k"], ["duration"]),
    # 미사용 입력 방지용 (0을 곱해 더함)
], "duration_predictor",
    [H.make_tensor_value_info("text_ids", TP.INT64, ["B", "T"]),
     H.make_tensor_value_info("style_dp", TP.FLOAT, ["B", 8, 16]),
     H.make_tensor_value_info("text_mask", TP.FLOAT, ["B", 1, "T"])],
    [H.make_tensor_value_info("duration", TP.FLOAT, ["B"])],
    initializer=[H.make_tensor("axes12", TP.INT64, [2], [1, 2])])
save(g, "duration_predictor")

# 2) text_encoder: text_emb[B,256,T] = text_mask ⊗ ones[1,256,1] + 0.01·mean(style_ttl)
g = H.make_graph([
    const("ones", np.ones((1, 256, 1), np.float32)),
    H.make_node("Mul", ["text_mask", "ones"], ["te0"]),
    H.make_node("ReduceMean", ["style_ttl"], ["sm"], axes=[1, 2], keepdims=0),
    const("c001", [0.01]),
    H.make_node("Mul", ["sm", "c001"], ["sm2"]),
    H.make_node("Unsqueeze", ["sm2", "axes12"], ["sm3"]),
    H.make_node("Add", ["te0", "sm3"], ["text_emb"]),
], "text_encoder",
    [H.make_tensor_value_info("text_ids", TP.INT64, ["B", "T"]),
     H.make_tensor_value_info("style_ttl", TP.FLOAT, ["B", 50, 256]),
     H.make_tensor_value_info("text_mask", TP.FLOAT, ["B", 1, "T"])],
    [H.make_tensor_value_info("text_emb", TP.FLOAT, ["B", 256, "T"])],
    initializer=[H.make_tensor("axes12", TP.INT64, [2], [1, 2])])
save(g, "text_encoder")

# 3) vector_estimator: denoised = noisy_latent × (1 - (current_step+1)/total_step)·0.5 + 0.5·latent_mask  → 스텝이 갈수록 잡음이 줄고 마스크 쪽으로 수렴
g = H.make_graph([
    const("one", [1.0]), const("half", [0.5]),
    H.make_node("Add", ["current_step", "one"], ["cs1"]),
    H.make_node("Div", ["cs1", "total_step"], ["frac0"]), const("c08", [0.8]), H.make_node("Mul", ["frac0", "c08"], ["frac"]),
    H.make_node("Sub", ["one", "frac"], ["keep"]),          # [B]
    H.make_node("Unsqueeze", ["keep", "axes12"], ["keep3"]),  # [B,1,1]
    H.make_node("Mul", ["noisy_latent", "keep3"], ["nl2"]),
    H.make_node("Mul", ["nl2", "half"], ["nl3"]),
    H.make_node("Mul", ["latent_mask", "half"], ["lm2"]),
    H.make_node("Add", ["nl3", "lm2"], ["den0"]),
    # 나머지 입력을 0 가중치로 소비
    H.make_node("ReduceMean", ["text_emb"], ["tm"], axes=[0, 1, 2], keepdims=0),
    H.make_node("ReduceMean", ["style_ttl"], ["sm"], axes=[0, 1, 2], keepdims=0),
    H.make_node("ReduceMean", ["text_mask"], ["mm"], axes=[0, 1, 2], keepdims=0),
    H.make_node("Add", ["tm", "sm"], ["z0"]), H.make_node("Add", ["z0", "mm"], ["z1"]),
    const("zero", [0.0]), H.make_node("Mul", ["z1", "zero"], ["z2"]),
    H.make_node("Add", ["den0", "z2"], ["denoised_latent"]),
], "vector_estimator",
    [H.make_tensor_value_info("noisy_latent", TP.FLOAT, ["B", D, "L"]),
     H.make_tensor_value_info("text_emb", TP.FLOAT, ["B", 256, "T"]),
     H.make_tensor_value_info("style_ttl", TP.FLOAT, ["B", 50, 256]),
     H.make_tensor_value_info("latent_mask", TP.FLOAT, ["B", 1, "L"]),
     H.make_tensor_value_info("text_mask", TP.FLOAT, ["B", 1, "T"]),
     H.make_tensor_value_info("current_step", TP.FLOAT, ["B"]),
     H.make_tensor_value_info("total_step", TP.FLOAT, ["B"])],
    [H.make_tensor_value_info("denoised_latent", TP.FLOAT, ["B", D, "L"])],
    initializer=[H.make_tensor("axes12", TP.INT64, [2], [1, 2])])
save(g, "vector_estimator")

# 4) vocoder: wav[B, L×3072] — 각 잠재 프레임의 첫 채널 값을 진폭으로 한 220Hz 정현파 (말소리 대용)
sine = (0.3 * np.sin(2 * np.pi * 220.0 * np.arange(CHUNK) / SR)).astype(np.float32)  # [3072]
g = H.make_graph([
    H.make_node("Slice", ["latent", "s0", "s1", "ax1"], ["a0"]),          # [B,1,L]
    H.make_node("Transpose", ["a0"], ["a1"], perm=[0, 2, 1]),             # [B,L,1]
    const("sine", sine.reshape(1, 1, CHUNK)),
    H.make_node("Mul", ["a1", "sine"], ["a2"]),                           # [B,L,3072]
    H.make_node("Shape", ["a2"], ["shp"]),
    H.make_node("Gather", ["shp", "i0"], ["b"]),                          # B
    H.make_node("Gather", ["shp", "i1"], ["l"]),                          # L
    H.make_node("Gather", ["shp", "i2"], ["c"]),                          # 3072
    H.make_node("Mul", ["l", "c"], ["lc"]),
    H.make_node("Unsqueeze", ["b", "ax0"], ["b1"]), H.make_node("Unsqueeze", ["lc", "ax0"], ["lc1"]),
    H.make_node("Concat", ["b1", "lc1"], ["newshape"], axis=0),
    H.make_node("Reshape", ["a2", "newshape"], ["wav_tts"]),
], "vocoder",
    [H.make_tensor_value_info("latent", TP.FLOAT, ["B", D, "L"])],
    [H.make_tensor_value_info("wav_tts", TP.FLOAT, ["B", "N"])],
    initializer=[H.make_tensor("s0", TP.INT64, [1], [0]), H.make_tensor("s1", TP.INT64, [1], [1]), H.make_tensor("ax1", TP.INT64, [1], [1]),
                 H.make_tensor("i0", TP.INT64, [], [0]), H.make_tensor("i1", TP.INT64, [], [1]), H.make_tensor("i2", TP.INT64, [], [2]),
                 H.make_tensor("ax0", TP.INT64, [1], [0])])
save(g, "vocoder")

# 설정 + 인덱서 (BMP 전체를 1..N 으로 사상, -1 없음)
json.dump({"ae": {"sample_rate": SR, "base_chunk_size": BASE_CHUNK}, "ttl": {"chunk_compress_factor": COMPRESS, "latent_dim": LATENT}}, open(f"{OUT}/onnx/tts.json", "w"))
indexer = [(cp % 4000) + 1 for cp in range(0x10000)]
json.dump(indexer, open(f"{OUT}/onnx/unicode_indexer.json", "w"))

# 스타일 10개 (결정적 난수)
rng = np.random.default_rng(7)
for i, name in enumerate(["M1","M2","M3","M4","M5","F1","F2","F3","F4","F5"]):
    ttl = (rng.standard_normal((1, 50, 256)) * 0.5 + (0.2 if name[0] == "F" else -0.2)).astype(np.float32)
    dp = (rng.standard_normal((1, 8, 16)) * 0.3).astype(np.float32)
    json.dump({"style_ttl": {"dims": [1, 50, 256], "data": ttl.tolist()}, "style_dp": {"dims": [1, 8, 16], "data": dp.tolist()}}, open(f"{OUT}/voice_styles/{name}.json", "w"))

# 매니페스트: vector_estimator 는 2조각으로 나눠 분할 다운로드 경로도 검증
files = {}
def add(rel, split=None):
    p = f"{OUT}/{rel}"; data = open(p, "rb").read()
    entry = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if split:
        half = len(data) // 2; parts = []
        for k, seg in enumerate([data[:half], data[half:]]):
            pp = f"{rel}.part{k}"; open(f"{OUT}/{pp}", "wb").write(seg); parts.append(pp)
        os.remove(p); entry["parts"] = parts
    files[rel] = entry
for rel in ["onnx/tts.json", "onnx/unicode_indexer.json", "onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vocoder.onnx"]: add(rel)
add("onnx/vector_estimator.onnx", split=True)
for name in ["M1","M2","M3","M4","M5","F1","F2","F3","F4","F5"]: add(f"voice_styles/{name}.json")
# variants 는 실제 mirror_models.py 출력과 같은 모양이어야 한다 (모델 이름을 키로).
# int8 변형은 파일을 따로 만들지 않고 같은 파일을 가리키게 해서, 엔진의 변형 해석 경로가
# 테스트에서 반드시 실행되도록 한다 — 이 경로가 비어 있어 실배포에서만 터지는 버그가 있었다.
MODELS = ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"]
variants = {v: {m: f"onnx/{m}.onnx" for m in MODELS} for v in ("fp32", "int8")}
json.dump({"name": "supertonic-3", "variant": "fixture", "revision": "fixture", "license": "fixture", "sampleRate": SR,
           "styles": ["M1","M2","M3","M4","M5","F1","F2","F3","F4","F5"],
           "variants": variants, "files": files}, open(f"{OUT}/manifest.json", "w"), indent=1)
print("fixtures written to", OUT)
for k, v in files.items(): print(f"  {k:36s} {v['size']:>9d} B" + (f"  parts={len(v['parts'])}" if 'parts' in v else ""))
