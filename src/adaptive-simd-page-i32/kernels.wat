(module
  (memory (export "memory") 1)

  (func $packed_at (param $packed i32) (param $width i32) (param $index i32) (result i32)
    (local $bit i32) (local $word i32) (local $shift i32) (local $value i32) (local $mask i32)
    local.get $index local.get $width i32.mul local.set $bit
    local.get $bit i32.const 5 i32.shr_u local.set $word
    local.get $bit i32.const 31 i32.and local.set $shift
    local.get $packed local.get $word i32.const 2 i32.shl i32.add i32.load
    local.get $shift i32.shr_u local.set $value
    local.get $shift local.get $width i32.add i32.const 32 i32.gt_u
    if
      local.get $value
      local.get $packed local.get $word i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      i32.const 32 local.get $shift i32.sub i32.shl i32.or local.set $value
    end
    i32.const 1 local.get $width i32.shl i32.const 1 i32.sub local.set $mask
    local.get $value local.get $mask i32.and
  )

  (func $for4
    (param $packed i32) (param $width i32) (param $base i32) (param $index i32) (param $n i32)
    (result v128)
    (local $values v128)
    local.get $base i32x4.splat local.set $values
    local.get $index local.get $n i32.lt_u
    if
      local.get $values local.get $base
      local.get $packed local.get $width local.get $index call $packed_at i32.add
      i32x4.replace_lane 0 local.set $values
    end
    local.get $index i32.const 1 i32.add local.get $n i32.lt_u
    if
      local.get $values local.get $base
      local.get $packed local.get $width local.get $index i32.const 1 i32.add call $packed_at i32.add
      i32x4.replace_lane 1 local.set $values
    end
    local.get $index i32.const 2 i32.add local.get $n i32.lt_u
    if
      local.get $values local.get $base
      local.get $packed local.get $width local.get $index i32.const 2 i32.add call $packed_at i32.add
      i32x4.replace_lane 2 local.set $values
    end
    local.get $index i32.const 3 i32.add local.get $n i32.lt_u
    if
      local.get $values local.get $base
      local.get $packed local.get $width local.get $index i32.const 3 i32.add call $packed_at i32.add
      i32x4.replace_lane 3 local.set $values
    end
    local.get $values
  )

  (func $store_mask4 (param $output i32) (param $index i32) (param $n i32) (param $bits i32)
    (local $remaining i32) (local $address i32)
    local.get $n local.get $index i32.sub local.set $remaining
    local.get $remaining i32.const 4 i32.lt_u
    if
      local.get $bits i32.const 1 local.get $remaining i32.shl i32.const 1 i32.sub i32.and
      local.set $bits
    end
    local.get $output local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
    local.set $address
    local.get $address
    local.get $address i32.load
    local.get $bits local.get $index i32.const 31 i32.and i32.shl i32.or
    i32.store
  )

  (func (export "decode_raw") (param $input i32) (param $output i32) (param $n i32)
    local.get $output local.get $input local.get $n i32.const 2 i32.shl memory.copy
  )

  (func (export "decode_for")
    (param $packed i32) (param $output i32) (param $n i32) (param $width i32) (param $base i32)
    (local $i i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $output local.get $i i32.const 2 i32.shl i32.add
      local.get $base local.get $packed local.get $width local.get $i call $packed_at i32.add i32.store
      local.get $i i32.const 1 i32.add local.set $i br $loop
    end end
  )

  (func (export "sum_raw") (param $input i32) (param $n i32) (result i64)
    (local $i i32) (local $end4 i32) (local $chunk v128)
    (local $low v128) (local $high v128) (local $total i64)
    local.get $n i32.const -4 i32.and local.set $end4
    block $vectors_done loop $vectors
      local.get $i local.get $end4 i32.ge_u br_if $vectors_done
      local.get $input local.get $i i32.const 2 i32.shl i32.add v128.load local.set $chunk
      local.get $low local.get $chunk i64x2.extend_low_i32x4_s i64x2.add local.set $low
      local.get $high local.get $chunk i64x2.extend_high_i32x4_s i64x2.add local.set $high
      local.get $i i32.const 4 i32.add local.set $i br $vectors
    end end
    local.get $low i64x2.extract_lane 0
    local.get $low i64x2.extract_lane 1 i64.add
    local.get $high i64x2.extract_lane 0 i64.add
    local.get $high i64x2.extract_lane 1 i64.add local.set $total
    block $done loop $tail
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $total local.get $input local.get $i i32.const 2 i32.shl i32.add
      i32.load i64.extend_i32_s i64.add local.set $total
      local.get $i i32.const 1 i32.add local.set $i br $tail
    end end
    local.get $total
  )

  (func (export "sum_for")
    (param $packed i32) (param $n i32) (param $width i32) (param $base i32) (result i64)
    (local $i i32) (local $total i64)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $total local.get $base local.get $packed local.get $width local.get $i
      call $packed_at i32.add i64.extend_i32_s i64.add local.set $total
      local.get $i i32.const 1 i32.add local.set $i br $loop
    end end
    local.get $total
  )

  (func (export "scan_eq_raw")
    (param $input i32) (param $output i32) (param $n i32) (param $value i32)
    (local $i i32) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $input local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $value i32x4.splat i32x4.eq i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func (export "scan_eq_for")
    (param $packed i32) (param $output i32) (param $n i32) (param $width i32) (param $base i32) (param $value i32)
    (local $i i32) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $packed local.get $width local.get $base local.get $i local.get $n call $for4
      local.get $value i32x4.splat i32x4.eq i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func (export "scan_lt_raw")
    (param $input i32) (param $output i32) (param $n i32) (param $value i32)
    (local $i i32) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $input local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $value i32x4.splat i32x4.lt_s i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func (export "scan_lt_for")
    (param $packed i32) (param $output i32) (param $n i32) (param $width i32) (param $base i32) (param $value i32)
    (local $i i32) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $packed local.get $width local.get $base local.get $i local.get $n call $for4
      local.get $value i32x4.splat i32x4.lt_s i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func (export "scan_between_raw")
    (param $input i32) (param $output i32) (param $n i32) (param $minimum i32) (param $maximum i32)
    (local $i i32) (local $values v128) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $input local.get $i i32.const 2 i32.shl i32.add v128.load local.set $values
      local.get $values local.get $minimum i32x4.splat i32x4.ge_s
      local.get $values local.get $maximum i32x4.splat i32x4.lt_s v128.and
      i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func (export "scan_between_for")
    (param $packed i32) (param $output i32) (param $n i32) (param $width i32) (param $base i32)
    (param $minimum i32) (param $maximum i32)
    (local $i i32) (local $values v128) (local $bits i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $packed local.get $width local.get $base local.get $i local.get $n call $for4 local.set $values
      local.get $values local.get $minimum i32x4.splat i32x4.ge_s
      local.get $values local.get $maximum i32x4.splat i32x4.lt_s v128.and
      i32x4.bitmask local.set $bits
      local.get $output local.get $i local.get $n local.get $bits call $store_mask4
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )

  (func $gather_raw_impl
    (param $input i32) (param $mask i32) (param $output i32) (param $n i32) (result i32)
    (local $index i32) (local $written i32)
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
      if
        local.get $output local.get $written i32.const 2 i32.shl i32.add
        local.get $input local.get $index i32.const 2 i32.shl i32.add i32.load i32.store
        local.get $written i32.const 1 i32.add local.set $written
      end
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $written
  )

  (func (export "gather_raw")
    (param $input i32) (param $mask i32) (param $output i32) (param $n i32) (result i32)
    local.get $input local.get $mask local.get $output local.get $n call $gather_raw_impl
  )

  (func (export "gather_for")
    (param $packed i32) (param $mask i32) (param $output i32) (param $n i32)
    (param $width i32) (param $base i32) (result i32)
    (local $index i32) (local $written i32)
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
      if
        local.get $output local.get $written i32.const 2 i32.shl i32.add
        local.get $base local.get $packed local.get $width local.get $index call $packed_at i32.add i32.store
        local.get $written i32.const 1 i32.add local.set $written
      end
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $written
  )

  (func (export "mask_and") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load v128.and v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_or") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load v128.or v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_andnot") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load v128.andnot v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_not") (param $pointer i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $pointer local.get $word i32.const 2 i32.shl i32.add
      local.get $pointer local.get $word i32.const 2 i32.shl i32.add v128.load v128.not v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_count") (param $pointer i32) (param $word_count i32) (result i32)
    (local $word i32) (local $bytes v128) (local $pairs v128) (local $quads v128) (local $count i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $pointer local.get $word i32.const 2 i32.shl i32.add v128.load i8x16.popcnt local.set $bytes
      local.get $bytes i16x8.extadd_pairwise_i8x16_u local.set $pairs
      local.get $pairs i32x4.extadd_pairwise_i16x8_u local.set $quads
      local.get $count
      local.get $quads i32x4.extract_lane 0 i32.add
      local.get $quads i32x4.extract_lane 1 i32.add
      local.get $quads i32x4.extract_lane 2 i32.add
      local.get $quads i32x4.extract_lane 3 i32.add local.set $count
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
    local.get $count
  )
)
