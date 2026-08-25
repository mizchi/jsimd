build:
    wasm-tools parse src/bytes/kernels.wat -o src/bytes/kernels.wasm
    wasm-tools parse src/bitset/kernels.wat -o src/bitset/kernels.wasm
    wasm-tools parse src/f32-vector/kernels.wat -o src/f32-vector/kernels.wasm
    wasm-tools validate --features simd src/bytes/kernels.wasm
    wasm-tools validate --features simd src/bitset/kernels.wasm
    wasm-tools validate --features simd src/f32-vector/kernels.wasm
    wasm-tools print src/bytes/kernels.wasm | rg -q 'find_byte'
    ! wasm-tools print src/bytes/kernels.wasm | rg -q 'intersection_count|\(export "dot"'
    wasm-tools print src/bitset/kernels.wasm | rg -q 'intersection_count'
    ! wasm-tools print src/bitset/kernels.wasm | rg -q 'find_byte|\(export "dot"'
    wasm-tools print src/f32-vector/kernels.wasm | rg -q '\(export "dot"'
    ! wasm-tools print src/f32-vector/kernels.wasm | rg -q 'find_byte|intersection_count'

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
    wasm-tools print examples/tree-shake-bitset/dist/assets/*.wasm | rg -q 'intersection_count'
    ! wasm-tools print examples/tree-shake-bitset/dist/assets/*.wasm | rg -q '\(export "dot"'
