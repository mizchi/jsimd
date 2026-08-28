(module
  (import "jsimd" "memory" (memory 1 65536 shared))

  ;; The caller clears the padded output span before invoking this kernel.
  (func (export "scan_i32_between_mask")
    (param $values i32) (param $length i32)
    (param $minimum i32) (param $maximum i32) (param $mask i32)
    (local $index i32) (local $end4 i32) (local $bits i32)
    (local $address i32) (local $value i32) (local $lanes v128)

    local.get $length i32.const -4 i32.and local.set $end4
    block $simd_done loop $simd
      local.get $index local.get $end4 i32.ge_u br_if $simd_done
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      v128.load align=4 local.tee $lanes
      local.get $minimum i32x4.splat i32x4.ge_s
      local.get $lanes local.get $maximum i32x4.splat i32x4.lt_s
      v128.and i32x4.bitmask
      local.get $index i32.const 31 i32.and i32.shl local.set $bits
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
      local.tee $address local.get $address i32.load local.get $bits i32.or i32.store
      local.get $index i32.const 4 i32.add local.set $index
      br $simd
    end end

    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $values local.get $index i32.const 2 i32.shl i32.add i32.load
      local.tee $value local.get $minimum i32.ge_s
      local.get $value local.get $maximum i32.lt_s i32.and
      if
        local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
        local.tee $address local.get $address i32.load
        i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.or i32.store
      end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end)

  (func (export "mask_and") (param $left i32) (param $right i32) (param $padded_words i32)
    (local $index i32) (local $bytes i32)
    local.get $padded_words i32.const 2 i32.shl local.set $bytes
    block $done loop $loop
      local.get $index local.get $bytes i32.ge_u br_if $done
      local.get $left local.get $index i32.add
      local.get $left local.get $index i32.add v128.load
      local.get $right local.get $index i32.add v128.load
      v128.and v128.store
      local.get $index i32.const 16 i32.add local.set $index
      br $loop
    end end)

  ;; Result layout: u32 count @ 0, i64 sum @ 8, i32 min @ 16, i32 max @ 20.
  (func (export "aggregate_i32_mask")
    (param $values i32) (param $length i32) (param $mask i32) (param $result i32)
    (local $index i32) (local $end4 i32) (local $bits i32)
    (local $count i32) (local $value i32) (local $minimum i32) (local $maximum i32)
    (local $tail_sum i64) (local $vector_sum i64)
    (local $lanes v128) (local $lane_mask v128) (local $selected v128)
    (local $sum_low v128) (local $sum_high v128)
    (local $minimums v128) (local $maximums v128)

    i32.const 2147483647 local.set $minimum
    i32.const -2147483648 local.set $maximum
    i32.const 2147483647 i32x4.splat local.set $minimums
    i32.const -2147483648 i32x4.splat local.set $maximums
    i64.const 0 i64x2.splat local.set $sum_low
    i64.const 0 i64x2.splat local.set $sum_high
    local.get $length i32.const -4 i32.and local.set $end4

    block $simd_done loop $simd
      local.get $index local.get $end4 i32.ge_u br_if $simd_done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
      i32.load
      local.get $index i32.const 31 i32.and i32.shr_u
      i32.const 15 i32.and local.tee $bits
      i32.popcnt local.get $count i32.add local.set $count

      local.get $bits i32x4.splat
      v128.const i32x4 1 2 4 8
      v128.and
      v128.const i32x4 0 0 0 0
      i32x4.eq
      v128.not
      local.set $lane_mask
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      v128.load align=4 local.set $lanes
      local.get $lanes v128.const i32x4 0 0 0 0 local.get $lane_mask
      v128.bitselect local.set $selected
      local.get $sum_low local.get $selected i64x2.extend_low_i32x4_s i64x2.add
      local.set $sum_low
      local.get $sum_high local.get $selected i64x2.extend_high_i32x4_s i64x2.add
      local.set $sum_high
      local.get $minimums
      local.get $lanes i32.const 2147483647 i32x4.splat local.get $lane_mask v128.bitselect
      i32x4.min_s local.set $minimums
      local.get $maximums
      local.get $lanes i32.const -2147483648 i32x4.splat local.get $lane_mask v128.bitselect
      i32x4.max_s local.set $maximums

      local.get $index i32.const 4 i32.add local.set $index
      br $simd
    end end

    block $tail_done loop $tail
      local.get $index local.get $length i32.ge_u br_if $tail_done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
      if
        local.get $values local.get $index i32.const 2 i32.shl i32.add i32.load local.tee $value
        i64.extend_i32_s local.get $tail_sum i64.add local.set $tail_sum
        local.get $count i32.const 1 i32.add local.set $count
        local.get $value local.get $minimum i32.lt_s
        if local.get $value local.set $minimum end
        local.get $value local.get $maximum i32.gt_s
        if local.get $value local.set $maximum end
      end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end

    local.get $sum_low local.get $sum_high i64x2.add local.set $sum_low
    local.get $sum_low i64x2.extract_lane 0
    local.get $sum_low i64x2.extract_lane 1 i64.add local.get $tail_sum i64.add
    local.set $vector_sum

    ;; Fold vector minimum and maximum lanes into the scalar tail state.
    local.get $minimums i32x4.extract_lane 0 local.tee $value local.get $minimum i32.lt_s
    if local.get $value local.set $minimum end
    local.get $minimums i32x4.extract_lane 1 local.tee $value local.get $minimum i32.lt_s
    if local.get $value local.set $minimum end
    local.get $minimums i32x4.extract_lane 2 local.tee $value local.get $minimum i32.lt_s
    if local.get $value local.set $minimum end
    local.get $minimums i32x4.extract_lane 3 local.tee $value local.get $minimum i32.lt_s
    if local.get $value local.set $minimum end
    local.get $maximums i32x4.extract_lane 0 local.tee $value local.get $maximum i32.gt_s
    if local.get $value local.set $maximum end
    local.get $maximums i32x4.extract_lane 1 local.tee $value local.get $maximum i32.gt_s
    if local.get $value local.set $maximum end
    local.get $maximums i32x4.extract_lane 2 local.tee $value local.get $maximum i32.gt_s
    if local.get $value local.set $maximum end
    local.get $maximums i32x4.extract_lane 3 local.tee $value local.get $maximum i32.gt_s
    if local.get $value local.set $maximum end

    local.get $result local.get $count i32.store
    local.get $result local.get $vector_sum i64.store offset=8
    local.get $result
    local.get $count i32.eqz if (result i32) i32.const 0 else local.get $minimum end
    i32.store offset=16
    local.get $result
    local.get $count i32.eqz if (result i32) i32.const 0 else local.get $maximum end
    i32.store offset=20)
)
