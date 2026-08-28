(module
  (import "jsimd" "memory" (memory 1 65536 shared))

  ;; Barrier-delimited merge of two disjoint aggregate state blocks.
  ;; Counts/null counts and extrema use four i32 lanes; sums use two i64x2 vectors.
  (func (export "merge_aggregate_state_blocks")
    (param $destination_counts i32)
    (param $destination_null_counts i32)
    (param $destination_sums i32)
    (param $destination_minimums i32)
    (param $destination_maximums i32)
    (param $source_counts i32)
    (param $source_null_counts i32)
    (param $source_sums i32)
    (param $source_minimums i32)
    (param $source_maximums i32)
    (param $length i32)
    (local $destination_value i32)
    (local $source_value i32)

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $destination_counts
        local.get $destination_counts
        v128.load align=4
        local.get $source_counts
        v128.load align=4
        i32x4.add
        v128.store align=4

        local.get $destination_null_counts
        local.get $destination_null_counts
        v128.load align=4
        local.get $source_null_counts
        v128.load align=4
        i32x4.add
        v128.store align=4

        local.get $destination_sums
        local.get $destination_sums
        v128.load align=8
        local.get $source_sums
        v128.load align=8
        i64x2.add
        v128.store align=8
        local.get $destination_sums
        i32.const 16
        i32.add
        local.get $destination_sums
        v128.load offset=16 align=8
        local.get $source_sums
        v128.load offset=16 align=8
        i64x2.add
        v128.store align=8

        local.get $destination_minimums
        local.get $destination_minimums
        v128.load align=4
        local.get $source_minimums
        v128.load align=4
        i32x4.min_s
        v128.store align=4

        local.get $destination_maximums
        local.get $destination_maximums
        v128.load align=4
        local.get $source_maximums
        v128.load align=4
        i32x4.max_s
        v128.store align=4

        local.get $destination_counts
        i32.const 16
        i32.add
        local.set $destination_counts
        local.get $destination_null_counts
        i32.const 16
        i32.add
        local.set $destination_null_counts
        local.get $destination_sums
        i32.const 32
        i32.add
        local.set $destination_sums
        local.get $destination_minimums
        i32.const 16
        i32.add
        local.set $destination_minimums
        local.get $destination_maximums
        i32.const 16
        i32.add
        local.set $destination_maximums
        local.get $source_counts
        i32.const 16
        i32.add
        local.set $source_counts
        local.get $source_null_counts
        i32.const 16
        i32.add
        local.set $source_null_counts
        local.get $source_sums
        i32.const 32
        i32.add
        local.set $source_sums
        local.get $source_minimums
        i32.const 16
        i32.add
        local.set $source_minimums
        local.get $source_maximums
        i32.const 16
        i32.add
        local.set $source_maximums
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done

        local.get $destination_counts
        local.get $destination_counts
        i32.load align=4
        local.get $source_counts
        i32.load align=4
        i32.add
        i32.store align=4
        local.get $destination_null_counts
        local.get $destination_null_counts
        i32.load align=4
        local.get $source_null_counts
        i32.load align=4
        i32.add
        i32.store align=4
        local.get $destination_sums
        local.get $destination_sums
        i64.load align=8
        local.get $source_sums
        i64.load align=8
        i64.add
        i64.store align=8
        local.get $destination_minimums
        i32.load align=4
        local.set $destination_value
        local.get $source_minimums
        i32.load align=4
        local.set $source_value
        local.get $destination_minimums
        local.get $destination_value
        local.get $source_value
        local.get $destination_value
        local.get $source_value
        i32.lt_s
        select
        i32.store align=4
        local.get $destination_maximums
        i32.load align=4
        local.set $destination_value
        local.get $source_maximums
        i32.load align=4
        local.set $source_value
        local.get $destination_maximums
        local.get $destination_value
        local.get $source_value
        local.get $destination_value
        local.get $source_value
        i32.gt_s
        select
        i32.store align=4

        local.get $destination_counts
        i32.const 4
        i32.add
        local.set $destination_counts
        local.get $destination_null_counts
        i32.const 4
        i32.add
        local.set $destination_null_counts
        local.get $destination_sums
        i32.const 8
        i32.add
        local.set $destination_sums
        local.get $destination_minimums
        i32.const 4
        i32.add
        local.set $destination_minimums
        local.get $destination_maximums
        i32.const 4
        i32.add
        local.set $destination_maximums
        local.get $source_counts
        i32.const 4
        i32.add
        local.set $source_counts
        local.get $source_null_counts
        i32.const 4
        i32.add
        local.set $source_null_counts
        local.get $source_sums
        i32.const 8
        i32.add
        local.set $source_sums
        local.get $source_minimums
        i32.const 4
        i32.add
        local.set $source_minimums
        local.get $source_maximums
        i32.const 4
        i32.add
        local.set $source_maximums
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )
  )

  ;; Scans [pointer, pointer + length * 4) for minimum <= value < maximum.
  ;; The caller owns result: u32 count at +0 and signed i64 sum at +8.
  (func (export "scan_i32_between_aggregate")
    (param $pointer i32)
    (param $length i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $result i32)
    (local $values v128)
    (local $mask v128)
    (local $selected v128)
    (local $counts v128)
    (local $sum_low v128)
    (local $sum_high v128)
    (local $count i32)
    (local $sum i64)
    (local $value i32)

    v128.const i32x4 0 0 0 0
    local.set $counts
    v128.const i64x2 0 0
    local.set $sum_low
    v128.const i64x2 0 0
    local.set $sum_high

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $pointer
        v128.load align=4
        local.tee $values
        local.get $minimum
        i32x4.splat
        i32x4.ge_s
        local.get $values
        local.get $maximum
        i32x4.splat
        i32x4.lt_s
        v128.and
        local.set $mask

        local.get $counts
        local.get $mask
        i32x4.sub
        local.set $counts

        local.get $values
        local.get $mask
        v128.and
        local.tee $selected
        i64x2.extend_low_i32x4_s
        local.get $sum_low
        i64x2.add
        local.set $sum_low

        local.get $selected
        i64x2.extend_high_i32x4_s
        local.get $sum_high
        i64x2.add
        local.set $sum_high

        local.get $pointer
        i32.const 16
        i32.add
        local.set $pointer
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    local.get $counts
    i32x4.extract_lane 0
    local.get $counts
    i32x4.extract_lane 1
    i32.add
    local.get $counts
    i32x4.extract_lane 2
    i32.add
    local.get $counts
    i32x4.extract_lane 3
    i32.add
    local.set $count

    local.get $sum_low
    i64x2.extract_lane 0
    local.get $sum_low
    i64x2.extract_lane 1
    i64.add
    local.get $sum_high
    i64x2.extract_lane 0
    i64.add
    local.get $sum_high
    i64x2.extract_lane 1
    i64.add
    local.set $sum

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done

        local.get $pointer
        i32.load align=4
        local.tee $value
        local.get $minimum
        i32.ge_s
        local.get $value
        local.get $maximum
        i32.lt_s
        i32.and
        if
          local.get $count
          i32.const 1
          i32.add
          local.set $count
          local.get $sum
          local.get $value
          i64.extend_i32_s
          i64.add
          local.set $sum
        end

        local.get $pointer
        i32.const 4
        i32.add
        local.set $pointer
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )

    local.get $result
    local.get $count
    i32.store align=4
    local.get $result
    local.get $sum
    i64.store offset=8 align=8
  )

  (func $group_update
    (param $group i32)
    (param $value i32)
    (param $counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (local $word_offset i32)
    (local $sum_offset i32)
    (local $count i32)

    local.get $group
    i32.const 2
    i32.shl
    local.set $word_offset
    local.get $group
    i32.const 3
    i32.shl
    local.set $sum_offset

    local.get $counts
    local.get $word_offset
    i32.add
    i32.load align=4
    local.set $count

    local.get $counts
    local.get $word_offset
    i32.add
    local.get $count
    i32.const 1
    i32.add
    i32.store align=4

    local.get $sums
    local.get $sum_offset
    i32.add
    local.get $sums
    local.get $sum_offset
    i32.add
    i64.load align=8
    local.get $value
    i64.extend_i32_s
    i64.add
    i64.store align=8

    local.get $count
    i32.eqz
    if
      local.get $minimums
      local.get $word_offset
      i32.add
      local.get $value
      i32.store align=4
      local.get $maximums
      local.get $word_offset
      i32.add
      local.get $value
      i32.store align=4
    else
      local.get $value
      local.get $minimums
      local.get $word_offset
      i32.add
      i32.load align=4
      i32.lt_s
      if
        local.get $minimums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
      end
      local.get $value
      local.get $maximums
      local.get $word_offset
      i32.add
      i32.load align=4
      i32.gt_s
      if
        local.get $maximums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
      end
    end
  )

  ;; Filters four i32 rows at a time, then updates worker-private low-cardinality u8 groups.
  (func (export "scan_i32_between_group_by_u8")
    (param $filter i32)
    (param $values i32)
    (param $groups i32)
    (param $length i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (local $filters v128)
    (local $mask i32)
    (local $filter_value i32)

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $filter
        v128.load align=4
        local.tee $filters
        local.get $minimum
        i32x4.splat
        i32x4.ge_s
        local.get $filters
        local.get $maximum
        i32x4.splat
        i32x4.lt_s
        v128.and
        i32x4.bitmask
        local.set $mask

        local.get $mask
        i32.const 1
        i32.and
        if
          local.get $groups
          i32.load8_u
          local.get $values
          i32.load align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 2
        i32.and
        if
          local.get $groups
          i32.load8_u offset=1
          local.get $values
          i32.load offset=4 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 4
        i32.and
        if
          local.get $groups
          i32.load8_u offset=2
          local.get $values
          i32.load offset=8 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 8
        i32.and
        if
          local.get $groups
          i32.load8_u offset=3
          local.get $values
          i32.load offset=12 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end

        local.get $filter
        i32.const 16
        i32.add
        local.set $filter
        local.get $values
        i32.const 16
        i32.add
        local.set $values
        local.get $groups
        i32.const 4
        i32.add
        local.set $groups
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done
        local.get $filter
        i32.load align=4
        local.tee $filter_value
        local.get $minimum
        i32.ge_s
        local.get $filter_value
        local.get $maximum
        i32.lt_s
        i32.and
        if
          local.get $groups
          i32.load8_u
          local.get $values
          i32.load align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $filter
        i32.const 4
        i32.add
        local.set $filter
        local.get $values
        i32.const 4
        i32.add
        local.set $values
        local.get $groups
        i32.const 1
        i32.add
        local.set $groups
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )
  )
)
