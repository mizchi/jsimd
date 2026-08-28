build:
    wasm-tools strip -a packages/jsimd/src/adaptive-simd-page-i32/kernels.wat -o packages/jsimd/src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/bytes/kernels.wat -o packages/jsimd/src/bytes/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/bitmap/kernels.wat -o packages/jsimd/src/bitmap/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/bit-matrix/kernels.wat -o packages/jsimd/src/bit-matrix/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/bit-histogram32/kernels.wat -o packages/jsimd/src/bit-histogram32/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/byte-key-flat-hash/kernels.wat -o packages/jsimd/src/byte-key-flat-hash/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/binary-vector-index/kernels.wat -o packages/jsimd/src/binary-vector-index/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/blocked-vector-array/kernels.wat -o packages/jsimd/src/blocked-vector-array/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/bit-sliced-column/kernels.wat -o packages/jsimd/src/bit-sliced-column/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/endian/kernels.wat -o packages/jsimd/src/endian/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/elias-fano-sequence/kernels.wat -o packages/jsimd/src/elias-fano-sequence/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/flat-hash/kernels.wat -o packages/jsimd/src/flat-hash/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/flat-hash-fixed16/kernels.wat -o packages/jsimd/src/flat-hash-fixed16/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/fingerprint-group16/kernels.wat -o packages/jsimd/src/fingerprint-group16/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/f32-vector/kernels.wat -o packages/jsimd/src/f32-vector/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/i32-array/kernels.wat -o packages/jsimd/src/i32-array/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/json/kernels.wat -o packages/jsimd/src/json/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/matrix2d/kernels.wat -o packages/jsimd/src/matrix2d/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/matrix3d/kernels.wat -o packages/jsimd/src/matrix3d/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/rank-select-bit-vector/kernels.wat -o packages/jsimd/src/rank-select-bit-vector/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/roaring-bitmap/kernels.wat -o packages/jsimd/src/roaring-bitmap/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/shared-buffer/kernels.wat -o packages/jsimd/src/shared-buffer/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/static-mphf-u32/kernels.wat -o packages/jsimd/src/static-mphf-u32/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/packed-delta-uint32-list/kernels.wat -o packages/jsimd/src/packed-delta-uint32-list/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/wavelet-matrix-uint16/kernels.wat -o packages/jsimd/src/wavelet-matrix-uint16/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/wavelet-matrix-uint32/kernels.wat -o packages/jsimd/src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/wavelet-matrix-uint8/kernels.wat -o packages/jsimd/src/wavelet-matrix-uint8/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/fm-index-bytes/kernels.wat -o packages/jsimd/src/fm-index-bytes/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/compressed-string-table/kernels.wat -o packages/jsimd/src/compressed-string-table/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/columnar/kernels.wat -o packages/jsimd/src/columnar/kernels.wasm
    wasm-tools strip -a packages/jsimd/src/blocked-bloom-filter/kernels.wat -o packages/jsimd/src/blocked-bloom-filter/kernels.wasm
    wasm-tools strip -a packages/olap/src/kernels.wat -o packages/olap/src/kernels.wasm
    wasm-tools strip -a packages/olap/src/radix_order_u32.wat -o packages/olap/src/radix_order_u32.wasm
    wasm-tools strip -a experiments/parallel-hybrid-query/kernels.wat -o experiments/parallel-hybrid-query/kernels.wasm
    wasm-tools strip -a experiments/parallel-columnar-selection/kernels.wat -o experiments/parallel-columnar-selection/kernels.wasm
    wasm-tools strip -a experiments/parallel-bloom-filter/kernels.wat -o experiments/parallel-bloom-filter/kernels.wasm
    wasm-tools strip -a experiments/radix-sort-block/kernels.wat -o experiments/radix-sort-block/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/adaptive-simd-page-i32/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/bytes/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/bitmap/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/bit-matrix/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/bit-histogram32/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/byte-key-flat-hash/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/binary-vector-index/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/blocked-vector-array/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/bit-sliced-column/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/endian/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/elias-fano-sequence/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/flat-hash/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/flat-hash-fixed16/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/fingerprint-group16/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/f32-vector/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/i32-array/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/json/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/matrix2d/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/matrix3d/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/rank-select-bit-vector/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/roaring-bitmap/kernels.wasm
    wasm-tools validate --features threads,simd packages/jsimd/src/shared-buffer/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/static-mphf-u32/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/packed-delta-uint32-list/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/wavelet-matrix-uint16/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/wavelet-matrix-uint32/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/wavelet-matrix-uint8/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/fm-index-bytes/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/compressed-string-table/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/columnar/kernels.wasm
    wasm-tools validate --features simd packages/jsimd/src/blocked-bloom-filter/kernels.wasm
    wasm-tools validate --features threads,simd packages/olap/src/kernels.wasm
    wasm-tools validate --features simd packages/olap/src/radix_order_u32.wasm
    wasm-tools validate --features threads,simd experiments/parallel-hybrid-query/kernels.wasm
    wasm-tools validate --features threads,simd experiments/parallel-columnar-selection/kernels.wasm
    wasm-tools validate --features threads,simd experiments/parallel-bloom-filter/kernels.wasm
    wasm-tools validate --features simd experiments/radix-sort-block/kernels.wasm
    wasm-tools print packages/jsimd/src/adaptive-simd-page-i32/kernels.wasm | rg -q 'scan_between_for|scan_between_raw|scan_between_rle|scan_between_dictionary|scan_between_sparse|gather_sparse|sum_sparse|mask_count'
    ! wasm-tools print packages/jsimd/src/adaptive-simd-page-i32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/bytes/kernels.wasm | rg -q 'find_byte'
    ! wasm-tools print packages/jsimd/src/bytes/kernels.wasm | rg -q 'byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print packages/jsimd/src/bitmap/kernels.wasm | rg -q 'intersection_count'
    ! wasm-tools print packages/jsimd/src/bitmap/kernels.wasm | rg -q 'find_byte|\(export "dot"'
    wasm-tools print packages/jsimd/src/bit-matrix/kernels.wasm | rg -q 'boolean_multiply|transpose|sparse_has|v128.any_true'
    wasm-tools print packages/jsimd/src/bit-histogram32/kernels.wasm | rg -q 'i8x16.swizzle|i8x16.shr_u|i32x4.extend_low_i16x8_u'
    wasm-tools print packages/jsimd/src/byte-key-flat-hash/kernels.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    wasm-tools print packages/jsimd/src/binary-vector-index/kernels.wasm | rg -q 'distance_many|pdx_distance_many|pdx_distance_selected|i8x16.popcnt'
    wasm-tools print packages/jsimd/src/blocked-vector-array/kernels.wasm | rg -q 'squared_distance_many|l1_distance_many|inner_product_many|top_k_inner_product|f32x4.abs'
    wasm-tools print packages/jsimd/src/bit-sliced-column/kernels.wasm | rg -q 'scan_eq|scan_between|mask_count'
    ! wasm-tools print packages/jsimd/src/bit-sliced-column/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/endian/kernels.wasm | rg -q 'byte_swap32'
    ! wasm-tools print packages/jsimd/src/endian/kernels.wasm | rg -q 'find_byte|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print packages/jsimd/src/elias-fano-sequence/kernels.wasm | rg -q 'build_rank_index|lower_bound_many|decode_into'
    ! wasm-tools print packages/jsimd/src/elias-fano-sequence/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|quantile_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/flat-hash/kernels.wasm | rg -q 'lookup_many|insert_map_many|map_lookup_many_u64|rehash_map_u64|rehash_set'
    ! wasm-tools print packages/jsimd/src/flat-hash/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/flat-hash-fixed16/kernels.wasm | rg -q 'lookup_many|insert_map_many|i8x16.bitmask'
    wasm-tools print packages/jsimd/src/fingerprint-group16/kernels.wasm | rg -q 'match_many|i8x16.bitmask'
    wasm-tools print packages/jsimd/src/f32-vector/kernels.wasm | rg -q 'squared_distance|norm|cosine_similarity|\(export "dot"'
    ! wasm-tools print packages/jsimd/src/f32-vector/kernels.wasm | rg -q 'find_byte|intersection_count'
    wasm-tools print packages/jsimd/src/i32-array/kernels.wasm | rg -q '\(export "sum"'
    ! wasm-tools print packages/jsimd/src/i32-array/kernels.wasm | rg -q 'find_byte|byte_swap32|intersection_count|\(export "dot"'
    wasm-tools print packages/jsimd/src/json/kernels.wasm | rg -q 'json_token_starts'
    ! wasm-tools print packages/jsimd/src/json/kernels.wasm | rg -q 'find_byte|intersection_count|\(export "dot"'
    wasm-tools print packages/jsimd/src/matrix2d/kernels.wasm | rg -q 'matmul'
    ! wasm-tools print packages/jsimd/src/matrix2d/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"'
    wasm-tools print packages/jsimd/src/matrix3d/kernels.wasm | rg -q 'batched_matmul'
    ! wasm-tools print packages/jsimd/src/matrix3d/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/rank-select-bit-vector/kernels.wasm | rg -q 'build_rank_index|select1|select0|rank0_many|next0|prev0'
    ! wasm-tools print packages/jsimd/src/rank-select-bit-vector/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/roaring-bitmap/kernels.wasm | rg -q 'bitmap_and_count|bitmap_or_into|bitmap_xor_into|bitmap_and_not_into|array_bitmap_and_into'
    ! wasm-tools print packages/jsimd/src/roaring-bitmap/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/shared-buffer/kernels.wasm | rg -q 'copy_bytes|reduce_shards_or|reduce_shards_and|reduce_shards_sum_u32|v128.or|v128.and|i32x4.add|i32x4.splat|v128.load|shared'
    wasm-tools print packages/jsimd/src/static-mphf-u32/kernels.wasm | rg -q 'lookup_many|i32x4.mul'
    ! wasm-tools print packages/jsimd/src/static-mphf-u32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/packed-delta-uint32-list/kernels.wasm | rg -q 'init_shuffle_table|decode_range|intersect_into'
    ! wasm-tools print packages/jsimd/src/packed-delta-uint32-list/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/wavelet-matrix-uint16/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print packages/jsimd/src/wavelet-matrix-uint16/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/wavelet-matrix-uint32/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print packages/jsimd/src/wavelet-matrix-uint32/kernels.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/wavelet-matrix-uint8/kernels.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    wasm-tools print packages/jsimd/src/fm-index-bytes/kernels.wasm | rg -q 'count_many|i8x16.popcnt'
    wasm-tools print packages/jsimd/src/compressed-string-table/kernels.wasm | rg -q 'equals_many|i8x16.bitmask'
    wasm-tools print packages/jsimd/src/columnar/kernels.wasm | rg -q 'scan_i32_between_for|scan_u32_between_for|i32x4.lt_u|scan_u8_eq|gather_i32_for|gather_u8|mask_positions_into|i8x16.popcnt'
    ! wasm-tools print packages/jsimd/src/columnar/kernels.wasm | rg -q 'find_byte|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    wasm-tools print packages/jsimd/src/blocked-bloom-filter/kernels.wasm | rg -q 'add_many|may_contain_many|merge|i32x4.all_true'
    wasm-tools print packages/olap/src/kernels.wasm | rg -q 'local_group_find|local_group_update_i32|local_group_aggregate_i32|local_group_aggregate_between_i32_u32|local_group_merge_partition|hash_join_build_u32|hash_join_count_u32|hash_join_probe_u32|merge_aggregate_state_blocks|scan_i32_between_aggregate|aggregate_i32_constant|scan_adaptive_i32_between_aggregate|scan_i32_between_group_by_u8|i64x2.add|i32x4.min_s|i32x4.max_s|i64x2.extend_low_i32x4_s|i32x4.bitmask|shared'
    wasm-tools print packages/olap/src/radix_order_u32.wasm | rg -q 'sort_u32_pairs|v128.store'
    wasm-tools print experiments/parallel-hybrid-query/kernels.wasm | rg -q 'scan_i32_between_mask|masked_squared_l2_top1_pdx64|masked_squared_l2_topk_pdx64|masked_squared_l2_topk_pdx64_pruned|masked_hamming_top1|masked_hamming_topk|pdx64_squared_l2_selected|i32x4.bitmask|f32x4.mul|i8x16.popcnt|shared'
    wasm-tools print experiments/parallel-columnar-selection/kernels.wasm | rg -q 'scan_i32_between_mask|mask_and|aggregate_i32_mask|i32x4.bitmask|i64x2.add|shared'
    wasm-tools print experiments/parallel-bloom-filter/kernels.wasm | rg -q 'add_many|may_contain_many|i32x4.all_true|shared'
    wasm-tools print experiments/radix-sort-block/kernels.wasm | rg -q 'sort_u32_pairs|sort_u32|sort_u64|v128.store'

test-olap-package: build
    deno test -A packages/olap/src

test-parallel-columnar-query: test-olap-package

test-parallel-hybrid-query: build
    deno test -A experiments/parallel-hybrid-query

test-parallel-columnar-selection: build
    deno test -A experiments/parallel-columnar-selection

test-parallel-bloom-filter: build
    deno test -A experiments/parallel-bloom-filter

test-radix-sort-block: build
    deno test -A experiments/radix-sort-block

test-striped-roaring-bitmap: build
    deno test -A experiments/striped-roaring-bitmap

bench-record-vitest suite output:
    deno run -A packages/bench/src/record_vitest.ts {{suite}} {{output}}

bench-record-all-vitest:
    deno run -A packages/bench/src/record_all_vitest.ts

bench-record-multithread-vector-search: build
    JSIMD_EXAMPLE_VECTOR_OUTPUT=examples/multithread-vector-search/benchmarks/baseline.json deno run -A examples/multithread-vector-search/bench.ts

bench-parallel-columnar-query: build
    deno run -A experiments/parallel-columnar-query/bench.ts

bench-record-parallel-columnar-query: build
    JSIMD_QUERY_OUTPUT=experiments/parallel-columnar-query/benchmarks/baseline.json deno run -A experiments/parallel-columnar-query/bench.ts

bench-striped-roaring-bitmap: build
    deno run -A experiments/striped-roaring-bitmap/bench.ts

bench-record-striped-roaring-bitmap: build
    JSIMD_STRIPED_ROARING_OUTPUT=experiments/striped-roaring-bitmap/benchmarks/resident-intersection-batch.json deno run -A experiments/striped-roaring-bitmap/bench.ts

bench-parallel-columnar-group-by: build
    deno run -A experiments/parallel-columnar-query/group_bench.ts

bench-parallel-columnar-local-group-hash: build
    deno run -A experiments/parallel-columnar-query/local_group_hash_bench.ts

bench-record-parallel-columnar-local-group-hash: build
    JSIMD_LOCAL_GROUP_OUTPUT=experiments/parallel-columnar-query/benchmarks/local-group-hash.json deno run -A experiments/parallel-columnar-query/local_group_hash_bench.ts

bench-parallel-columnar-hash-join: build
    deno run -A experiments/parallel-columnar-query/partitioned_hash_join_bench.ts

bench-record-parallel-columnar-hash-join: build
    JSIMD_JOIN_OUTPUT=experiments/parallel-columnar-query/benchmarks/partitioned-hash-join.json deno run -A experiments/parallel-columnar-query/partitioned_hash_join_bench.ts

bench-parallel-columnar-physical-pipeline: build
    deno run -A experiments/parallel-columnar-query/physical_pipeline_bench.ts

bench-record-parallel-columnar-physical-pipeline: build
    JSIMD_PIPELINE_OUTPUT=experiments/parallel-columnar-query/benchmarks/physical-pipeline.json deno run -A experiments/parallel-columnar-query/physical_pipeline_bench.ts

bench-parallel-columnar-worker-init: build
    deno run -A experiments/parallel-columnar-query/worker_module_init_bench.ts

bench-record-parallel-columnar-worker-init: build
    JSIMD_INIT_OUTPUT=experiments/parallel-columnar-query/benchmarks/worker-module-initialization.json deno run -A experiments/parallel-columnar-query/worker_module_init_bench.ts

bench-parallel-columnar-group-physical-pipeline: build
    deno run -A experiments/parallel-columnar-query/group_physical_pipeline_bench.ts

bench-record-parallel-columnar-group-physical-pipeline: build
    JSIMD_GROUP_PIPELINE_OUTPUT=experiments/parallel-columnar-query/benchmarks/group-physical-pipeline.json deno run -A experiments/parallel-columnar-query/group_physical_pipeline_bench.ts

bench-parallel-columnar-physical-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-physical-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-physical-pipeline
    deno run -A tools/bench-parallel-columnar-physical-browser.ts

bench-record-parallel-columnar-physical-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-physical-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-physical-pipeline
    JSIMD_BROWSER_PIPELINE_OUTPUT=experiments/parallel-columnar-query/benchmarks/browser-physical-pipeline.json deno run -A tools/bench-parallel-columnar-physical-browser.ts

bench-parallel-columnar-adaptive-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-adaptive-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-adaptive-pipeline
    deno run -A tools/bench-parallel-columnar-adaptive-browser.ts

bench-record-parallel-columnar-adaptive-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-adaptive-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-adaptive-pipeline
    JSIMD_BROWSER_ADAPTIVE_OUTPUT=experiments/parallel-columnar-query/benchmarks/browser-adaptive-pipeline.json deno run -A tools/bench-parallel-columnar-adaptive-browser.ts

bench-parallel-columnar-adaptive-pipeline: build
    deno run -A experiments/parallel-columnar-query/adaptive_pipeline_bench.ts

bench-record-parallel-columnar-adaptive-pipeline: build
    JSIMD_ADAPTIVE_OUTPUT=experiments/parallel-columnar-query/benchmarks/adaptive-pipeline.json deno run -A experiments/parallel-columnar-query/adaptive_pipeline_bench.ts

bench-record-parallel-columnar-group-by: build
    JSIMD_GROUP_OUTPUT=experiments/parallel-columnar-query/benchmarks/group-by.json deno run -A experiments/parallel-columnar-query/group_bench.ts

bench-record-parallel-columnar-log-group-by: build
    JSIMD_GROUP_WORKLOAD=logs JSIMD_GROUP_OUTPUT=experiments/parallel-columnar-query/benchmarks/log-group-by.json deno run -A experiments/parallel-columnar-query/group_bench.ts

bench-parallel-hybrid-query: build
    deno run -A experiments/parallel-hybrid-query/bench.ts

bench-parallel-columnar-selection: build
    deno run -A experiments/parallel-columnar-selection/bench.ts

bench-record-parallel-columnar-selection: build
    JSIMD_SELECTION_OUTPUT=experiments/parallel-columnar-selection/benchmarks/reusable-mask.json deno run -A experiments/parallel-columnar-selection/bench.ts

bench-parallel-bloom-filter: build
    deno run -A experiments/parallel-bloom-filter/bench.ts

bench-record-parallel-bloom-filter: build
    JSIMD_PARALLEL_BLOOM_OUTPUT=experiments/parallel-bloom-filter/benchmarks/worker-local-build.json deno run -A experiments/parallel-bloom-filter/bench.ts

bench-radix-sort-block: build
    deno run -A experiments/radix-sort-block/bench.ts

bench-record-radix-sort-block: build
    JSIMD_RADIX_OUTPUT=experiments/radix-sort-block/benchmarks/u32-u64.json deno run -A experiments/radix-sort-block/bench.ts

bench-parallel-hybrid-topk: build
    deno run -A experiments/parallel-hybrid-query/bench_topk.ts

bench-parallel-hybrid-binary: build
    deno run -A experiments/parallel-hybrid-query/bench_binary.ts

bench-record-parallel-hybrid-binary: build
    JSIMD_BINARY_OUTPUT=experiments/parallel-hybrid-query/benchmarks/binary-rerank.json deno run -A experiments/parallel-hybrid-query/bench_binary.ts

bench-parallel-hybrid-pdx-pruning: build
    deno run -A experiments/parallel-hybrid-query/bench_pdx_block_pruning.ts

bench-record-parallel-hybrid-pdx-pruning: build
    JSIMD_PDX_PRUNING_OUTPUT=experiments/parallel-hybrid-query/benchmarks/pdx-block-pruning.json deno run -A experiments/parallel-hybrid-query/bench_pdx_block_pruning.ts

test-webgpu-vector-search:
    deno test -A --unstable-webgpu experiments/webgpu-vector-search/gpu_index_test.ts

bench-webgpu-vector-search: build
    deno run -A --unstable-webgpu experiments/webgpu-vector-search/bench.ts

bench-record-webgpu-vector-search: build
    JSIMD_WEBGPU_OUTPUT=experiments/webgpu-vector-search/benchmarks/baseline.json deno run -A --unstable-webgpu experiments/webgpu-vector-search/bench.ts

bench-webgpu-vector-search-browser: build
    deno check --unstable-webgpu experiments/webgpu-vector-search/browser-benchmark/src.ts
    pnpm exec vite build experiments/webgpu-vector-search/browser-benchmark
    deno run -A tools/bench-webgpu-vector-search-browser.ts

bench-record-webgpu-vector-search-browser: build
    deno check --unstable-webgpu experiments/webgpu-vector-search/browser-benchmark/src.ts
    pnpm exec vite build experiments/webgpu-vector-search/browser-benchmark
    JSIMD_WEBGPU_BROWSER_OUTPUT=experiments/webgpu-vector-search/benchmarks/chromium.json deno run -A tools/bench-webgpu-vector-search-browser.ts

bench-parallel-columnar-duckdb-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/duckdb-comparison/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/duckdb-comparison
    deno run -A tools/bench-parallel-columnar-duckdb-browser.ts

bench-record-parallel-columnar-duckdb-browser: build
    pnpm exec tsc -p experiments/parallel-columnar-query/duckdb-comparison/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/duckdb-comparison
    JSIMD_DUCKDB_OUTPUT_DIR=experiments/parallel-columnar-query/benchmarks deno run -A tools/bench-parallel-columnar-duckdb-browser.ts

bench-columnar-schema-indexeddb-browser: build
    pnpm exec tsc -p packages/columnar/fixtures/browser-benchmark/tsconfig.json
    pnpm exec vite build packages/columnar/fixtures/browser-benchmark
    deno run -A tools/bench-columnar-schema-indexeddb-browser.ts

bench-record-columnar-schema-indexeddb-browser: build
    pnpm exec tsc -p packages/columnar/fixtures/browser-benchmark/tsconfig.json
    pnpm exec vite build packages/columnar/fixtures/browser-benchmark
    JSIMD_INDEXEDDB_OUTPUT=packages/columnar/benchmarks/indexeddb-browser.json deno run -A tools/bench-columnar-schema-indexeddb-browser.ts

bench-record-columnar-schema-engine: build
    JSIMD_COLUMNAR_SCHEMA_OUTPUT=packages/columnar/benchmarks/baseline.json deno run -A packages/columnar/benchmarks/record_benchmark.ts

bench-columnar-schema-engine: build
    pnpm exec vitest bench packages/columnar/benchmarks

check-benchmark-results:
    deno run -A tools/check-benchmark-results.ts

check-build-budgets:
    deno run -A tools/check-build-budgets.ts

build-jsimd-package: build
    deno run -A tools/build-package.ts

build-shared-package: build-jsimd-package
    deno run -A tools/build-typescript-package.ts shared

build-columnar-package: build-jsimd-package
    deno run -A tools/build-typescript-package.ts columnar

build-olap-package: build-jsimd-package build-shared-package build-columnar-package
    deno run -A tools/build-typescript-package.ts olap

build-package: build-shared-package build-columnar-package build-olap-package

memory-profile: build
    node --no-warnings --expose-gc tools/profile-memory.ts

snapshot-transport: build
    deno run -A tools/profile-snapshot-transport.ts

package-smoke: build-package
    deno run -A tools/smoke-package.ts
    deno run -A tools/smoke-olap-package.ts

test: build
    deno test -A

bench: build
    deno bench -A

check: test package-smoke
    test "$(find packages/jsimd/dist -name '*_test.js' -o -name '*_test.d.ts' | wc -l | tr -d ' ')" = "0"
    deno fmt --check
    deno lint
    deno run -A tools/check-benchmark-results.ts
    pnpm exec tsc -p experiments/parallel-columnar-query/duckdb-comparison/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/duckdb-comparison
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-physical-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-physical-pipeline
    pnpm exec tsc -p experiments/parallel-columnar-query/browser-adaptive-pipeline/tsconfig.json
    pnpm exec vite build experiments/parallel-columnar-query/browser-adaptive-pipeline
    deno eval 'const p = JSON.parse(await Deno.readTextFile("packages/jsimd/package.json")); const d = JSON.parse(await Deno.readTextFile("packages/jsimd/deno.json")); if (p.version !== d.version || JSON.stringify(Object.keys(p.exports)) !== JSON.stringify(Object.keys(d.exports))) throw new Error("package.json and deno.json release metadata differ")'
    pnpm exec tsc -p examples/tree-shake-blocked-bloom-filter/tsconfig.json
    pnpm exec vite build examples/tree-shake-blocked-bloom-filter
    test "$(find examples/tree-shake-blocked-bloom-filter/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-blocked-bloom-filter/dist/assets/*.wasm | rg -q 'add_many|may_contain_many|merge|i32x4.all_true'
    ! wasm-tools print examples/tree-shake-blocked-bloom-filter/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|quantile_many|matmul'
    pnpm exec tsc -p examples/tree-shake-blocked-vector-array/tsconfig.json
    pnpm exec vite build examples/tree-shake-blocked-vector-array
    test "$(find examples/tree-shake-blocked-vector-array/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-blocked-vector-array/dist/assets/*.wasm | rg -q 'squared_distance_many|l1_distance_many|inner_product_many|top_k_inner_product|f32x4.abs'
    ! wasm-tools print examples/tree-shake-blocked-vector-array/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|quantile_many|matmul'
    pnpm exec tsc -p examples/tree-shake-columnar/tsconfig.json
    pnpm exec vite build examples/tree-shake-columnar
    test "$(find examples/tree-shake-columnar/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-columnar/dist/assets/*.wasm | rg -q 'scan_i32_between_for|scan_u32_between_for|i32x4.lt_u|scan_u8_eq|gather_i32_for|gather_u8|mask_positions_into|i8x16.popcnt'
    ! wasm-tools print examples/tree-shake-columnar/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|lookup_many|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p packages/columnar/fixtures/tree-shake/tsconfig.json
    pnpm exec vite build packages/columnar/fixtures/tree-shake
    test "$(find packages/columnar/fixtures/tree-shake/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    pnpm exec tsc -p packages/olap/fixtures/vite/tsconfig.json
    pnpm exec vite build packages/olap/fixtures/vite
    test "$(find packages/olap/fixtures/vite/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "2"
    test "$(find packages/olap/fixtures/vite/dist/assets -name '*worker*.js' | wc -l | tr -d ' ')" = "1"
    deno run -A tools/test-olap-browser.ts
    pnpm exec tsc -p packages/olap/fixtures/radix-order-u32/tsconfig.json
    pnpm exec vite build packages/olap/fixtures/radix-order-u32
    test "$(find packages/olap/fixtures/radix-order-u32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    test "$(find packages/olap/fixtures/radix-order-u32/dist/assets -name '*worker*.js' | wc -l | tr -d ' ')" = "0"
    wasm-tools print packages/olap/fixtures/radix-order-u32/dist/assets/*.wasm | rg -q 'sort_u32_pairs|v128.store'
    wasm-tools print packages/columnar/fixtures/tree-shake/dist/assets/*.wasm | rg -q 'scan_i32_between_for|scan_u32_between_for|scan_u8_eq|gather_i32_for|gather_u8|mask_positions_into'
    ! rg -q 'node:fs|node:path' packages/columnar/fixtures/tree-shake/dist/assets/*.js
    pnpm exec tsc -p packages/columnar/fixtures/browser-benchmark/tsconfig.json
    pnpm exec vite build packages/columnar/fixtures/browser-benchmark
    pnpm exec tsc -p examples/tree-shake-binary-vector-index/tsconfig.json
    pnpm exec vite build examples/tree-shake-binary-vector-index
    test "$(find examples/tree-shake-binary-vector-index/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-binary-vector-index/dist/assets/*.wasm | rg -q 'distance_many|i8x16.popcnt'
    ! wasm-tools print examples/tree-shake-binary-vector-index/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|intersection_count|lookup_many|matmul'
    pnpm exec tsc -p examples/tree-shake-adaptive-simd-page-i32/tsconfig.json
    pnpm exec vite build examples/tree-shake-adaptive-simd-page-i32
    test "$(find examples/tree-shake-adaptive-simd-page-i32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-adaptive-simd-page-i32/dist/assets/*.wasm | rg -q 'scan_between_for|scan_between_raw|scan_between_rle|scan_between_dictionary|scan_between_sparse|gather_sparse|sum_sparse|mask_count'
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
    wasm-tools print examples/tree-shake-f32-vector/dist/assets/*.wasm | rg -q 'squared_distance|norm|cosine_similarity|\(export "dot"'
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
    pnpm exec tsc -p examples/tree-shake-bit-histogram32/tsconfig.json
    pnpm exec vite build examples/tree-shake-bit-histogram32
    test "$(find examples/tree-shake-bit-histogram32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-bit-histogram32/dist/assets/*.wasm | rg -q 'i8x16.swizzle|i8x16.shr_u|i32x4.extend_low_i16x8_u'
    ! wasm-tools print examples/tree-shake-bit-histogram32/dist/assets/*.wasm | rg -q 'find_byte|json_token_starts|lookup_many|quantile_many|matmul'
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
    pnpm exec tsc -p examples/tree-shake-shared-buffer/tsconfig.json
    pnpm exec vite build examples/tree-shake-shared-buffer
    test "$(find examples/tree-shake-shared-buffer/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools validate --features threads,simd examples/tree-shake-shared-buffer/dist/assets/*.wasm
    wasm-tools print examples/tree-shake-shared-buffer/dist/assets/*.wasm | rg -q 'copy_bytes|reduce_shards_or|reduce_shards_and|reduce_shards_sum_u32|v128.or|v128.and|i32x4.add|i32x4.splat|v128.load|shared'
    node --no-warnings tools/test-shared-buffer-node-workers.ts
    deno run -A tools/test-shared-buffer-browser.ts
    pnpm exec tsc -p examples/multithread-vector-search/tsconfig.json
    pnpm exec vite build examples/multithread-vector-search
    test "$(find examples/multithread-vector-search/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "2"
    find examples/multithread-vector-search/dist/assets -name '*.wasm' -exec wasm-tools validate --features threads,simd {} \;
    find examples/multithread-vector-search/dist/assets -name '*.wasm' -exec wasm-tools print {} \; | rg -q 'copy_bytes|reduce_shards_or|shared'
    find examples/multithread-vector-search/dist/assets -name '*.wasm' -exec wasm-tools print {} \; | rg -q 'squared_distance_many|top_k|f32x4'
    pnpm exec tsc -p examples/tree-shake-static-mphf-u32/tsconfig.json
    pnpm exec vite build examples/tree-shake-static-mphf-u32
    test "$(find examples/tree-shake-static-mphf-u32/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-static-mphf-u32/dist/assets/*.wasm | rg -q 'lookup_many|i32x4.mul'
    ! wasm-tools print examples/tree-shake-static-mphf-u32/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|decode_range|quantile_many|lower_bound_many|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-packed-delta-uint32-list/tsconfig.json
    pnpm exec vite build examples/tree-shake-packed-delta-uint32-list
    test "$(find examples/tree-shake-packed-delta-uint32-list/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-packed-delta-uint32-list/dist/assets/*.wasm | rg -q 'decode_range|intersect_into'
    ! wasm-tools print examples/tree-shake-packed-delta-uint32-list/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|build_rank_index|bitmap_and_count|\(export "dot"|\(export "matmul"'
    pnpm exec tsc -p examples/tree-shake-wavelet-matrix-uint16/tsconfig.json
    pnpm exec vite build examples/tree-shake-wavelet-matrix-uint16
    test "$(find examples/tree-shake-wavelet-matrix-uint16/dist/assets -name '*.wasm' | wc -l | tr -d ' ')" = "1"
    wasm-tools print examples/tree-shake-wavelet-matrix-uint16/dist/assets/*.wasm | rg -q 'access_many|rank_many|quantile_many|count_lt'
    ! wasm-tools print examples/tree-shake-wavelet-matrix-uint16/dist/assets/*.wasm | rg -q 'find_byte|byte_swap32|json_token_starts|intersection_count|batched_matmul|bitmap_and_count|decode_range|lookup_many|\(export "dot"|\(export "matmul"'
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
    deno run -A tools/check-build-budgets.ts
