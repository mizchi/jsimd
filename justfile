build:
    wasm-tools strip -a src/adaptive-simd-page-i32/kernels.wat -o src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools strip -a src/bytes/kernels.wat -o src/bytes/kernels.wasm
    wasm-tools strip -a src/bitset/kernels.wat -o src/bitset/kernels.wasm
    wasm-tools strip -a src/bit-sliced-column/kernels.wat -o src/bit-sliced-column/kernels.wasm
    wasm-tools strip -a src/endian/kernels.wat -o src/endian/kernels.wasm
    wasm-tools strip -a src/elias-fano-sequence/kernels.wat -o src/elias-fano-sequence/kernels.wasm
    wasm-tools strip -a src/flat-hash/kernels.wat -o src/flat-hash/kernels.wasm
    wasm-tools strip -a src/f32-vector/kernels.wat -o src/f32-vector/kernels.wasm
    wasm-tools strip -a src/i32-array/kernels.wat -o src/i32-array/kernels.wasm
    wasm-tools strip -a src/json/kernels.wat -o src/json/kernels.wasm
    wasm-tools strip -a src/matrix2d/kernels.wat -o src/matrix2d/kernels.wasm
    wasm-tools strip -a src/matrix3d/kernels.wat -o src/matrix3d/kernels.wasm
    wasm-tools strip -a src/rank-select-bitvector/kernels.wat -o src/rank-select-bitvector/kernels.wasm
    wasm-tools strip -a src/roaring-uint32-set/kernels.wat -o src/roaring-uint32-set/kernels.wasm
    wasm-tools strip -a src/packed-delta-uint32-list/kernels.wat -o src/packed-delta-uint32-list/kernels.wasm
    wasm-tools strip -a src/wavelet-matrix-uint32/kernels.wat -o src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools validate --features simd src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools validate --features simd src/bytes/kernels.wasm
    wasm-tools validate --features simd src/bitset/kernels.wasm
    wasm-tools validate --features simd src/bit-sliced-column/kernels.wasm
    wasm-tools validate --features simd src/endian/kernels.wasm
    wasm-tools validate --features simd src/elias-fano-sequence/kernels.wasm
    wasm-tools validate --features simd src/flat-hash/kernels.wasm
    wasm-tools validate --features simd src/f32-vector/kernels.wasm
    wasm-tools validate --features simd src/i32-array/kernels.wasm
    wasm-tools validate --features simd src/json/kernels.wasm
    wasm-tools validate --features simd src/matrix2d/kernels.wasm
    wasm-tools validate --features simd src/matrix3d/kernels.wasm
    wasm-tools validate --features simd src/rank-select-bitvector/kernels.wasm
    wasm-tools validate --features simd src/roaring-uint32-set/kernels.wasm
    wasm-tools validate --features simd src/packed-delta-uint32-list/kernels.wasm
    wasm-tools validate --features simd src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools print src/adaptive-simd-page-i32/kernels.wasm | rg -q 'scan_between_for|scan_between_raw|gather_for|mask_count'
    ! wasm-tools print src/adaptive-simd-page-i32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/bytes/kernels.wasm | rg -q 'find_byte'
    ! wasm-tools print src/bytes/kernels.wasm | rg -q 'byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print src/bitset/kernels.wasm | rg -q 'intersection_count'
    ! wasm-tools print src/bitset/kernels.wasm | rg -q 'find_byte|\(export "dot"'
    wasm-tools print src/bit-sliced-column/kernels.wasm | rg -q 'scan_eq|scan_between|mask_count'
    ! wasm-tools print src/bit-sliced-column/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/endian/kernels.wasm | rg -q 'byte_swap32'
    ! wasm-tools print src/endian/kernels.wasm | rg -q 'find_byte|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print src/elias-fano-sequence/kernels.wasm | rg -q 'build_rank_index|lower_bound_many|decode_into'
    ! wasm-tools print src/elias-fano-sequence/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/flat-hash/kernels.wasm | rg -q 'lookup_many|insert_map_many|rehash_set'
    ! wasm-tools print src/flat-hash/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|\(export "dot"|\(export "matmul"'
    wasm-tools print src/f32-vector/kernels.wasm | rg -q '\(export "dot"'
    ! wasm-tools print src/f32-vector/kernels.wasm | rg -q 'find_byte|intersection_count'
    wasm-tools print src/i32-array/kernels.wasm | rg -q '\(export "sum"'
    ! wasm-tools print src/i32-array/kernels.wasm | rg -q 'find_byte|byte_swap32|intersection_count|\(export "dot"'
    wasm-tools print src/json/kernels.wasm | rg -q 'json_token_starts'
    ! wasm-tools print src/json/kernels.wasm | rg -q 'find_byte|intersection_count|\(export "dot"'
    wasm-tools print src/matrix2d/kernels.wasm | rg -q 'matmul'
    ! wasm-tools print src/matrix2d/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print src/matrix3d/kernels.wasm | rg -q 'batched_matmul'
    ! wasm-tools print src/matrix3d/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"|\(export "matmul"'
    wasm-tools print src/rank-select-bitvector/kernels.wasm | rg -q 'build_rank_index|select1'
    ! wasm-tools print src/rank-select-bitvector/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|\(export "dot"|\(export "matmul"'
    wasm-tools print src/roaring-uint32-set/kernels.wasm | rg -q 'bitmap_and_count|array_bitmap_and_into'
    ! wasm-tools print src/roaring-uint32-set/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|\(export "dot"|\(export "matmul"'
    wasm-tools print src/packed-delta-uint32-list/kernels.wasm | rg -q 'init_shuffle_table|decode_range|intersect_into'
    ! wasm-tools print src/packed-delta-uint32-list/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|\(export "dot"|\(export "matmul"'
    wasm-tools print src/wavelet-matrix-uint32/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print src/wavelet-matrix-uint32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'

test: build
    deno test -A

bench: build
    deno bench -A

check: test
    deno fmt --check
    deno lint
    pnpm exec tsc -p examples/tree-shake-adaptive-simd-page-i32/tsconfig.json
    pnpm exec vite build examples/tree-shake-adaptive-simd-page-i32
    test "$(find examples/tree-shake-adaptive-simd-page-i32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-adaptive-simd-page-i32/dist/assets/*.wasm | rg -q 'scan_between_for|scan_between_raw|gather_for|mask_count'
    ! wasm-tools print examples/tree-shake-adaptive-simd-page-i32/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/vite/tsconfig.json
    pnpm exec vite build examples/vite
    pnpm exec tsc -p examples/tree-shake-bytes/tsconfig.json
    pnpm exec vite build examples/tree-shake-bytes
    test "$(find examples/tree-shake-bytes/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bytes/dist/assets/*.wasm | rg -q 'find_byte'
    ! wasm-tools print examples/tree-shake-bytes/dist/assets/*.wasm | rg -q 'byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-endian/tsconfig.json
    pnpm exec vite build examples/tree-shake-endian
    test "$(find examples/tree-shake-endian/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-endian/dist/assets/*.wasm | rg -q 'byte_swap32'
    ! wasm-tools print examples/tree-shake-endian/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-elias-fano-sequence/tsconfig.json
    pnpm exec vite build examples/tree-shake-elias-fano-sequence
    test "$(find examples/tree-shake-elias-fano-sequence/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-elias-fano-sequence/dist/assets/*.wasm | rg -q 'build_rank_index|lower_bound_many|decode_into'
    ! wasm-tools print examples/tree-shake-elias-fano-sequence/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-flat-hash/tsconfig.json
    pnpm exec vite build examples/tree-shake-flat-hash
    test "$(find examples/tree-shake-flat-hash/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-flat-hash/dist/assets/*.wasm | rg -q 'lookup_many|insert_map_many|rehash_set'
    ! wasm-tools print examples/tree-shake-flat-hash/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-i32-array/tsconfig.json
    pnpm exec vite build examples/tree-shake-i32-array
    test "$(find examples/tree-shake-i32-array/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-i32-array/dist/assets/*.wasm | rg -q '\(export "sum"'
    ! wasm-tools print examples/tree-shake-i32-array/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-bitset/tsconfig.json
    pnpm exec vite build examples/tree-shake-bitset
    test "$(find examples/tree-shake-bitset/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bitset/dist/assets/*.wasm | rg -q 'intersection_count'
    ! wasm-tools print examples/tree-shake-bitset/dist/assets/*.wasm | rg -q '\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-bit-sliced-column/tsconfig.json
    pnpm exec vite build examples/tree-shake-bit-sliced-column
    test "$(find examples/tree-shake-bit-sliced-column/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bit-sliced-column/dist/assets/*.wasm | rg -q 'scan_eq|scan_between|mask_count'
    ! wasm-tools print examples/tree-shake-bit-sliced-column/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-json/tsconfig.json
    pnpm exec vite build examples/tree-shake-json
    test "$(find examples/tree-shake-json/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-json/dist/assets/*.wasm | rg -q 'json_token_starts'
    ! wasm-tools print examples/tree-shake-json/dist/assets/*.wasm | rg -q 'find_byte|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-matrix2d/tsconfig.json
    pnpm exec vite build examples/tree-shake-matrix2d
    test "$(find examples/tree-shake-matrix2d/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-matrix2d/dist/assets/*.wasm | rg -q 'matmul'
    ! wasm-tools print examples/tree-shake-matrix2d/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-matrix3d/tsconfig.json
    pnpm exec vite build examples/tree-shake-matrix3d
    test "$(find examples/tree-shake-matrix3d/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-matrix3d/dist/assets/*.wasm | rg -q 'batched_matmul'
    ! wasm-tools print examples/tree-shake-matrix3d/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-rank-select-bitvector/tsconfig.json
    pnpm exec vite build examples/tree-shake-rank-select-bitvector
    test "$(find examples/tree-shake-rank-select-bitvector/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-rank-select-bitvector/dist/assets/*.wasm | rg -q 'build_rank_index|select1'
    ! wasm-tools print examples/tree-shake-rank-select-bitvector/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-roaring-uint32-set/tsconfig.json
    pnpm exec vite build examples/tree-shake-roaring-uint32-set
    test "$(find examples/tree-shake-roaring-uint32-set/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-roaring-uint32-set/dist/assets/*.wasm | rg -q 'bitmap_and_count|array_bitmap_and_into'
    ! wasm-tools print examples/tree-shake-roaring-uint32-set/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-packed-delta-uint32-list/tsconfig.json
    pnpm exec vite build examples/tree-shake-packed-delta-uint32-list
    test "$(find examples/tree-shake-packed-delta-uint32-list/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-packed-delta-uint32-list/dist/assets/*.wasm | rg -q 'decode_range|intersect_into'
    ! wasm-tools print examples/tree-shake-packed-delta-uint32-list/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-wavelet-matrix-uint32/tsconfig.json
    pnpm exec vite build examples/tree-shake-wavelet-matrix-uint32
    test "$(find examples/tree-shake-wavelet-matrix-uint32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-wavelet-matrix-uint32/dist/assets/*.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print examples/tree-shake-wavelet-matrix-uint32/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
