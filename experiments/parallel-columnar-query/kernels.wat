(module
  (import "jsimd" "memory" (memory 1 65536 shared))

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
)
