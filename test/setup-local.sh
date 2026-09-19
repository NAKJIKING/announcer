#!/usr/bin/env bash
# 로컬에서 테스트를 돌리기 위한 준비: onnxruntime-web 내려받기 + 대체 모델 생성.
# 실제 가중치는 받지 않는다 (개발 컨테이너에서는 허깅페이스가 막혀 있다).
set -euo pipefail
cd "$(dirname "$0")/.."
ORT_VER="${ORT_VER:-1.30.0}"

if [ ! -f vendor/ort/ort.webgpu.min.js ]; then
  echo "· onnxruntime-web@$ORT_VER 내려받는 중"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  ( cd "$tmp" && npm pack "onnxruntime-web@$ORT_VER" >/dev/null && tar xzf onnxruntime-web-*.tgz )
  mkdir -p vendor/ort
  for f in ort.webgpu.min.js ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm \
           ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm; do
    cp "$tmp/package/dist/$f" vendor/ort/ 2>/dev/null || echo "  (없음: $f)"
  done
  du -sh vendor/ort
fi

if [ ! -f test/fixtures/supertonic-3/manifest.json ]; then
  echo "· 대체 모델 생성"
  python3 test/make-fixtures.py test/fixtures/supertonic-3 >/dev/null
fi
mkdir -p models
[ -e models/supertonic-3 ] || ln -s ../test/fixtures/supertonic-3 models/supertonic-3
echo "준비 완료. 이제:"
echo "  node test/regress.js            # 앱 회귀 (file://)"
echo "  node test/engine.spec.js .      # 엔진 단위"
echo "  node test/app-neural.spec.js .  # 앱+엔진 통합 (http)"
