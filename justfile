build:
    mkdir -p dist
    wasm-tools parse src/kernels.wat -o dist/jsimd.wasm
    wasm-tools parse src/bitset.wat -o dist/bitset.wasm
    wasm-tools parse src/f32-vector.wat -o dist/f32-vector.wasm
    wasm-tools validate --features simd dist/jsimd.wasm
    wasm-tools validate --features simd dist/bitset.wasm
    wasm-tools validate --features simd dist/f32-vector.wasm

test: build
    deno test -A

bench: build
    deno bench -A

check: test
    deno fmt --check
    deno lint
    pnpm exec tsc -p examples/vite/tsconfig.json
    pnpm exec vite build examples/vite
    pnpm exec tsc -p examples/tree-shake-bitset/tsconfig.json
    pnpm exec vite build examples/tree-shake-bitset
    test "$(find examples/tree-shake-bitset/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    find examples/tree-shake-bitset/dist/assets -name 'bitset-*.wasm' | rg -q .
