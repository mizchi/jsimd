build:
    wasm-tools strip -a src/adaptive-simd-page-i32/kernels.wat -o src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools strip -a src/bytes/kernels.wat -o src/bytes/kernels.wasm
    wasm-tools strip -a src/bitmap/kernels.wat -o src/bitmap/kernels.wasm
    wasm-tools strip -a src/bit-matrix/kernels.wat -o src/bit-matrix/kernels.wasm
    wasm-tools strip -a src/byte-key-flat-hash/kernels.wat -o src/byte-key-flat-hash/kernels.wasm
    wasm-tools strip -a src/binary-vector-index/kernels.wat -o src/binary-vector-index/kernels.wasm
    wasm-tools strip -a src/blocked-vector-array/kernels.wat -o src/blocked-vector-array/kernels.wasm
    wasm-tools strip -a src/bit-sliced-column/kernels.wat -o src/bit-sliced-column/kernels.wasm
    wasm-tools strip -a src/endian/kernels.wat -o src/endian/kernels.wasm
    wasm-tools strip -a src/elias-fano-sequence/kernels.wat -o src/elias-fano-sequence/kernels.wasm
    wasm-tools strip -a src/flat-hash/kernels.wat -o src/flat-hash/kernels.wasm
    wasm-tools strip -a src/flat-hash-fixed16/kernels.wat -o src/flat-hash-fixed16/kernels.wasm
    wasm-tools strip -a src/fingerprint-group16/kernels.wat -o src/fingerprint-group16/kernels.wasm
    wasm-tools strip -a src/f32-vector/kernels.wat -o src/f32-vector/kernels.wasm
    wasm-tools strip -a src/i32-array/kernels.wat -o src/i32-array/kernels.wasm
    wasm-tools strip -a src/json/kernels.wat -o src/json/kernels.wasm
    wasm-tools strip -a src/matrix2d/kernels.wat -o src/matrix2d/kernels.wasm
    wasm-tools strip -a src/matrix3d/kernels.wat -o src/matrix3d/kernels.wasm
    wasm-tools strip -a src/rank-select-bit-vector/kernels.wat -o src/rank-select-bit-vector/kernels.wasm
    wasm-tools strip -a src/roaring-bitmap/kernels.wat -o src/roaring-bitmap/kernels.wasm
    wasm-tools strip -a src/static-mphf-u32/kernels.wat -o src/static-mphf-u32/kernels.wasm
    wasm-tools strip -a src/static-mphf-bytes/kernels.wat -o src/static-mphf-bytes/kernels.wasm
    wasm-tools strip -a src/packed-delta-uint32-list/kernels.wat -o src/packed-delta-uint32-list/kernels.wasm
    wasm-tools strip -a src/wavelet-matrix-uint32/kernels.wat -o src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools strip -a src/wavelet-matrix-uint8/kernels.wat -o src/wavelet-matrix-uint8/kernels.wasm
    wasm-tools strip -a src/fm-index-bytes/kernels.wat -o src/fm-index-bytes/kernels.wasm
    wasm-tools strip -a src/compressed-string-table/kernels.wat -o src/compressed-string-table/kernels.wasm
    wasm-tools strip -a src/columnar/kernels.wat -o src/columnar/kernels.wasm
    wasm-tools strip -a src/blocked-bloom-filter/kernels.wat -o src/blocked-bloom-filter/kernels.wasm
    wasm-tools validate --features simd src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools validate --features simd src/bytes/kernels.wasm
    wasm-tools validate --features simd src/bitmap/kernels.wasm
    wasm-tools validate --features simd src/bit-matrix/kernels.wasm
    wasm-tools validate --features simd src/byte-key-flat-hash/kernels.wasm
    wasm-tools validate --features simd src/binary-vector-index/kernels.wasm
    wasm-tools validate --features simd src/blocked-vector-array/kernels.wasm
    wasm-tools validate --features simd src/bit-sliced-column/kernels.wasm
    wasm-tools validate --features simd src/endian/kernels.wasm
    wasm-tools validate --features simd src/elias-fano-sequence/kernels.wasm
    wasm-tools validate --features simd src/flat-hash/kernels.wasm
    wasm-tools validate --features simd src/flat-hash-fixed16/kernels.wasm
    wasm-tools validate --features simd src/fingerprint-group16/kernels.wasm
    wasm-tools validate --features simd src/f32-vector/kernels.wasm
    wasm-tools validate --features simd src/i32-array/kernels.wasm
    wasm-tools validate --features simd src/json/kernels.wasm
    wasm-tools validate --features simd src/matrix2d/kernels.wasm
    wasm-tools validate --features simd src/matrix3d/kernels.wasm
    wasm-tools validate --features simd src/rank-select-bit-vector/kernels.wasm
    wasm-tools validate --features simd src/roaring-bitmap/kernels.wasm
    wasm-tools validate --features simd src/static-mphf-u32/kernels.wasm
    wasm-tools validate --features simd src/static-mphf-bytes/kernels.wasm
    wasm-tools validate --features simd src/packed-delta-uint32-list/kernels.wasm
    wasm-tools validate --features simd src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools validate --features simd src/wavelet-matrix-uint8/kernels.wasm
    wasm-tools validate --features simd src/fm-index-bytes/kernels.wasm
    wasm-tools validate --features simd src/compressed-string-table/kernels.wasm
    wasm-tools validate --features simd src/columnar/kernels.wasm
    wasm-tools validate --features simd src/blocked-bloom-filter/kernels.wasm
    wasm-tools print src/adaptive-simd-page-i32/kernels.wasm | rg -q 'scan_between_for|scan_between_raw|gather_for|mask_count'
    ! wasm-tools print src/adaptive-simd-page-i32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/bytes/kernels.wasm | rg -q 'find_byte'
    ! wasm-tools print src/bytes/kernels.wasm | rg -q 'byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print src/bitmap/kernels.wasm | rg -q 'intersection_count'
    ! wasm-tools print src/bitmap/kernels.wasm | rg -q 'find_byte|\(export "dot"'
    wasm-tools print src/bit-matrix/kernels.wasm | rg -q 'boolean_multiply|transpose|sparse_has|v128.any_true'
    wasm-tools print src/byte-key-flat-hash/kernels.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    wasm-tools print src/binary-vector-index/kernels.wasm | rg -q 'distance_many|pdx_distance_many|pdx_distance_selected|i8x16.popcnt'
    wasm-tools print src/blocked-vector-array/kernels.wasm | rg -q 'squared_distance_many|f32x4.mul'
    wasm-tools print src/bit-sliced-column/kernels.wasm | rg -q 'scan_eq|scan_between|mask_count'
    ! wasm-tools print src/bit-sliced-column/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/endian/kernels.wasm | rg -q 'byte_swap32'
    ! wasm-tools print src/endian/kernels.wasm | rg -q 'find_byte|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print src/elias-fano-sequence/kernels.wasm | rg -q 'build_rank_index|lower_bound_many|decode_into'
    ! wasm-tools print src/elias-fano-sequence/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/flat-hash/kernels.wasm | rg -q 'lookup_many|insert_map_many|map_lookup_many_u64|rehash_map_u64|rehash_set'
    ! wasm-tools print src/flat-hash/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|\(export "dot"|\(export "matmul"'
    wasm-tools print src/flat-hash-fixed16/kernels.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    wasm-tools print src/fingerprint-group16/kernels.wasm | rg -q 'match_many|i8x16.bitmask'
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
    wasm-tools print src/rank-select-bit-vector/kernels.wasm | rg -q 'build_rank_index|select1|select0|rank0_many|next0|prev0'
    ! wasm-tools print src/rank-select-bit-vector/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|\(export "dot"|\(export "matmul"'
    wasm-tools print src/roaring-bitmap/kernels.wasm | rg -q 'bitmap_and_count|bitmap_or_into|bitmap_xor_into|bitmap_and_not_into|array_bitmap_and_into'
    ! wasm-tools print src/roaring-bitmap/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|\(export "dot"|\(export "matmul"'
    wasm-tools print src/static-mphf-u32/kernels.wasm | rg -q 'lookup_many|i32x4.mul'
    ! wasm-tools print src/static-mphf-u32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/static-mphf-bytes/kernels.wasm | rg -q 'lookup_many|lookup_values_many|i8x16.bitmask'
    wasm-tools print src/packed-delta-uint32-list/kernels.wasm | rg -q 'init_shuffle_table|decode_range|intersect_into'
    ! wasm-tools print src/packed-delta-uint32-list/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|\(export "dot"|\(export "matmul"'
    wasm-tools print src/wavelet-matrix-uint32/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print src/wavelet-matrix-uint32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/wavelet-matrix-uint8/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    wasm-tools print src/fm-index-bytes/kernels.wasm | rg -q 'count_many|i8x16.popcnt'
    wasm-tools print src/compressed-string-table/kernels.wasm | rg -q 'equals_many|i8x16.bitmask'
    wasm-tools print src/columnar/kernels.wasm | rg -q 'scan_i32_between_for|scan_u32_between_for|i32x4.lt_u|scan_u8_eq|mask_positions_into|i8x16.popcnt'
    ! wasm-tools print src/columnar/kernels.wasm | rg -q 'find_byte|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print src/blocked-bloom-filter/kernels.wasm | rg -q 'add_many|may_contain_many|merge|i32x4.all_true'

build-package: build
    deno run -A tools/build-package.ts

memory-profile: build
    node --no-warnings --expose-gc tools/profile-memory.ts

snapshot-transport: build
    deno run -A tools/profile-snapshot-transport.ts

package-smoke: build-package
    deno run -A tools/smoke-package.ts

test: build
    deno test -A

bench: build
    deno bench -A

check: test package-smoke
    deno fmt --check
    deno lint
    deno eval 'const p = JSON.parse(await Deno.readTextFile("package.json")); const d = JSON.parse(await Deno.readTextFile("deno.json")); if (p.version !== d.version || JSON.stringify(Object.keys(p.exports)) !== JSON.stringify(Object.keys(d.exports))) throw new Error("package.json and deno.json release metadata differ")'
    pnpm exec tsc -p examples/tree-shake-blocked-bloom-filter/tsconfig.json
    pnpm exec vite build examples/tree-shake-blocked-bloom-filter
    test "$(find examples/tree-shake-blocked-bloom-filter/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-blocked-bloom-filter/dist/assets/*.wasm | rg -q 'add_many|may_contain_many|merge|i32x4.all_true'
    ! wasm-tools print examples/tree-shake-blocked-bloom-filter/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|quantile_many|matmul'
    pnpm exec tsc -p examples/tree-shake-blocked-vector-array/tsconfig.json
    pnpm exec vite build examples/tree-shake-blocked-vector-array
    test "$(find examples/tree-shake-blocked-vector-array/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-blocked-vector-array/dist/assets/*.wasm | rg -q 'squared_distance_many|f32x4.mul'
    ! wasm-tools print examples/tree-shake-blocked-vector-array/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|quantile_many|matmul'
    pnpm exec tsc -p examples/tree-shake-columnar/tsconfig.json
    pnpm exec vite build examples/tree-shake-columnar
    test "$(find examples/tree-shake-columnar/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-columnar/dist/assets/*.wasm | rg -q 'scan_i32_between_for|scan_u32_between_for|i32x4.lt_u|scan_u8_eq|mask_positions_into|i8x16.popcnt'
    ! wasm-tools print examples/tree-shake-columnar/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-binary-vector-index/tsconfig.json
    pnpm exec vite build examples/tree-shake-binary-vector-index
    test "$(find examples/tree-shake-binary-vector-index/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-binary-vector-index/dist/assets/*.wasm | rg -q 'distance_many|i8x16.popcnt'
    ! wasm-tools print examples/tree-shake-binary-vector-index/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|matmul'
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
    pnpm exec tsc -p examples/tree-shake-flat-hash-fixed16/tsconfig.json
    pnpm exec vite build examples/tree-shake-flat-hash-fixed16
    test "$(find examples/tree-shake-flat-hash-fixed16/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-flat-hash-fixed16/dist/assets/*.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    ! wasm-tools print examples/tree-shake-flat-hash-fixed16/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|quantile_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-fingerprint-group16/tsconfig.json
    pnpm exec vite build examples/tree-shake-fingerprint-group16
    test "$(find examples/tree-shake-fingerprint-group16/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-fingerprint-group16/dist/assets/*.wasm | rg -q 'match_many|i8x16.bitmask'
    ! wasm-tools print examples/tree-shake-fingerprint-group16/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-f32-vector/tsconfig.json
    pnpm exec vite build examples/tree-shake-f32-vector
    test "$(find examples/tree-shake-f32-vector/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-f32-vector/dist/assets/*.wasm | rg -q '\(export "dot"'
    ! wasm-tools print examples/tree-shake-f32-vector/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|intersection_count|matmul'
    pnpm exec tsc -p examples/tree-shake-i32-array/tsconfig.json
    pnpm exec vite build examples/tree-shake-i32-array
    test "$(find examples/tree-shake-i32-array/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-i32-array/dist/assets/*.wasm | rg -q '\(export "sum"'
    ! wasm-tools print examples/tree-shake-i32-array/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-bitmap/tsconfig.json
    pnpm exec vite build examples/tree-shake-bitmap
    test "$(find examples/tree-shake-bitmap/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bitmap/dist/assets/*.wasm | rg -q 'intersection_count'
    ! wasm-tools print examples/tree-shake-bitmap/dist/assets/*.wasm | rg -q '\(export "dot"'
    pnpm exec tsc -p examples/tree-shake-bit-matrix/tsconfig.json
    pnpm exec vite build examples/tree-shake-bit-matrix
    test "$(find examples/tree-shake-bit-matrix/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bit-matrix/dist/assets/*.wasm | rg -q 'boolean_multiply|transpose|v128.any_true'
    ! wasm-tools print examples/tree-shake-bit-matrix/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-byte-key-flat-hash/tsconfig.json
    pnpm exec vite build examples/tree-shake-byte-key-flat-hash
    test "$(find examples/tree-shake-byte-key-flat-hash/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-byte-key-flat-hash/dist/assets/*.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    ! wasm-tools print examples/tree-shake-byte-key-flat-hash/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|quantile_many|boolean_multiply|\(export "dot"|\(export "matmul"'
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
    pnpm exec tsc -p examples/tree-shake-rank-select-bit-vector/tsconfig.json
    pnpm exec vite build examples/tree-shake-rank-select-bit-vector
    test "$(find examples/tree-shake-rank-select-bit-vector/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-rank-select-bit-vector/dist/assets/*.wasm | rg -q 'build_rank_index|select1|select0|rank0_many|next0|prev0'
    ! wasm-tools print examples/tree-shake-rank-select-bit-vector/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-roaring-bitmap/tsconfig.json
    pnpm exec vite build examples/tree-shake-roaring-bitmap
    test "$(find examples/tree-shake-roaring-bitmap/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-roaring-bitmap/dist/assets/*.wasm | rg -q 'bitmap_and_count|bitmap_or_into|bitmap_xor_into|bitmap_and_not_into|array_bitmap_and_into'
    ! wasm-tools print examples/tree-shake-roaring-bitmap/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-static-mphf-u32/tsconfig.json
    pnpm exec vite build examples/tree-shake-static-mphf-u32
    test "$(find examples/tree-shake-static-mphf-u32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-static-mphf-u32/dist/assets/*.wasm | rg -q 'lookup_many|i32x4.mul'
    ! wasm-tools print examples/tree-shake-static-mphf-u32/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-static-mphf-bytes/tsconfig.json
    pnpm exec vite build examples/tree-shake-static-mphf-bytes
    test "$(find examples/tree-shake-static-mphf-bytes/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-static-mphf-bytes/dist/assets/*.wasm | rg -q 'lookup_many|lookup_values_many|i8x16.bitmask'
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
    pnpm exec tsc -p examples/tree-shake-wavelet-matrix-uint8/tsconfig.json
    pnpm exec vite build examples/tree-shake-wavelet-matrix-uint8
    test "$(find examples/tree-shake-wavelet-matrix-uint8/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-wavelet-matrix-uint8/dist/assets/*.wasm | rg -q 'access_many|rank_many|quantile_many'
    pnpm exec tsc -p examples/tree-shake-fm-index-bytes/tsconfig.json
    pnpm exec vite build examples/tree-shake-fm-index-bytes
    test "$(find examples/tree-shake-fm-index-bytes/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-fm-index-bytes/dist/assets/*.wasm | rg -q 'count_many|i8x16.popcnt'
    pnpm exec tsc -p examples/tree-shake-compressed-string-table/tsconfig.json
    pnpm exec vite build examples/tree-shake-compressed-string-table
    test "$(find examples/tree-shake-compressed-string-table/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-compressed-string-table/dist/assets/*.wasm | rg -q 'equals_many|i8x16.bitmask'
