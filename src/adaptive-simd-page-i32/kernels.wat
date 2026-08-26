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

  (func $dictionary_lower_bound
    (param $dictionary i32) (param $cardinality i32) (param $target i32) (result i32)
    (local $code i32)
    block $done loop $loop
      local.get $code local.get $cardinality i32.ge_u br_if $done
      local.get $dictionary local.get $code i32.const 2 i32.shl i32.add i32.load
      local.get $target i32.ge_s br_if $done
      local.get $code i32.const 1 i32.add local.set $code br $loop
    end end
    local.get $code)

  (func $store_mask16 (param $output i32) (param $index i32) (param $n i32) (param $bits i32)
    (local $remaining i32)
    local.get $n local.get $index i32.sub local.set $remaining
    local.get $remaining i32.const 16 i32.lt_u
    if
      local.get $bits i32.const 1 local.get $remaining i32.shl i32.const 1 i32.sub i32.and
      local.set $bits
    end
    local.get $output local.get $index i32.const 3 i32.shr_u i32.add
    local.get $bits i32.store16)

  ;; Dictionary values are sorted i32s, followed by u32 counts and one u8 code per row.
  (func (export "decode_dictionary")
    (param $dictionary i32) (param $codes i32) (param $output i32) (param $n i32)
    (local $index i32) (local $code i32)
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $codes local.get $index i32.add i32.load8_u local.set $code
      local.get $output local.get $index i32.const 2 i32.shl i32.add
      local.get $dictionary local.get $code i32.const 2 i32.shl i32.add i32.load i32.store
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end)

  (func (export "sum_dictionary")
    (param $dictionary i32) (param $cardinality i32) (result i64)
    (local $code i32) (local $counts i32) (local $total i64)
    local.get $dictionary local.get $cardinality i32.const 2 i32.shl i32.add local.set $counts
    block $done loop $loop
      local.get $code local.get $cardinality i32.ge_u br_if $done
      local.get $total
      local.get $dictionary local.get $code i32.const 2 i32.shl i32.add i32.load i64.extend_i32_s
      local.get $counts local.get $code i32.const 2 i32.shl i32.add i32.load i64.extend_i32_u
      i64.mul i64.add local.set $total
      local.get $code i32.const 1 i32.add local.set $code br $loop
    end end
    local.get $total)

  (func (export "scan_eq_dictionary")
    (param $dictionary i32) (param $codes i32) (param $output i32) (param $n i32)
    (param $cardinality i32) (param $target i32)
    (local $index i32) (local $code i32) (local $bits i32)
    local.get $dictionary local.get $cardinality local.get $target
    call $dictionary_lower_bound local.set $code
    local.get $code local.get $cardinality i32.lt_u
    if
      local.get $dictionary local.get $code i32.const 2 i32.shl i32.add i32.load
      local.get $target i32.eq
      if
        block $done loop $loop
          local.get $index local.get $n i32.ge_u br_if $done
          local.get $codes local.get $index i32.add v128.load
          local.get $code i8x16.splat i8x16.eq i8x16.bitmask local.set $bits
          local.get $output local.get $index local.get $n local.get $bits call $store_mask16
          local.get $index i32.const 16 i32.add local.set $index br $loop
        end end
      end
    end)

  (func (export "scan_lt_dictionary")
    (param $dictionary i32) (param $codes i32) (param $output i32) (param $n i32)
    (param $cardinality i32) (param $target i32)
    (local $index i32) (local $upper i32) (local $bits i32)
    local.get $dictionary local.get $cardinality local.get $target
    call $dictionary_lower_bound local.set $upper
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $codes local.get $index i32.add v128.load
      local.get $upper i8x16.splat i8x16.lt_u i8x16.bitmask local.set $bits
      local.get $output local.get $index local.get $n local.get $bits call $store_mask16
      local.get $index i32.const 16 i32.add local.set $index br $loop
    end end)

  (func (export "scan_between_dictionary")
    (param $dictionary i32) (param $codes i32) (param $output i32) (param $n i32)
    (param $cardinality i32) (param $minimum i32) (param $maximum i32)
    (local $index i32) (local $lower i32) (local $upper i32)
    (local $values v128) (local $bits i32)
    local.get $dictionary local.get $cardinality local.get $minimum
    call $dictionary_lower_bound local.set $lower
    local.get $dictionary local.get $cardinality local.get $maximum
    call $dictionary_lower_bound local.set $upper
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $codes local.get $index i32.add v128.load local.set $values
      local.get $values local.get $lower i8x16.splat i8x16.ge_u
      local.get $values local.get $upper i8x16.splat i8x16.lt_u v128.and
      i8x16.bitmask local.set $bits
      local.get $output local.get $index local.get $n local.get $bits call $store_mask16
      local.get $index i32.const 16 i32.add local.set $index br $loop
    end end)

  (func (export "gather_dictionary")
    (param $dictionary i32) (param $codes i32) (param $mask i32) (param $output i32)
    (param $n i32) (result i32)
    (local $index i32) (local $written i32) (local $code i32)
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
      if
        local.get $codes local.get $index i32.add i32.load8_u local.set $code
        local.get $output local.get $written i32.const 2 i32.shl i32.add
        local.get $dictionary local.get $code i32.const 2 i32.shl i32.add i32.load i32.store
        local.get $written i32.const 1 i32.add local.set $written
      end
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $written)

  (func $mask_fill_n (param $output i32) (param $n i32)
    (local $word i32) (local $word_count i32) (local $remaining i32)
    local.get $n i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_count
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $output local.get $word i32.const 2 i32.shl i32.add i32.const -1 i32.store
      local.get $word i32.const 1 i32.add local.set $word br $loop
    end end
    local.get $n i32.const 31 i32.and local.set $remaining
    local.get $remaining i32.eqz i32.eqz
    if
      local.get $output local.get $word_count i32.const 1 i32.sub i32.const 2 i32.shl i32.add
      i32.const 1 local.get $remaining i32.shl i32.const 1 i32.sub i32.store
    end)

  (func $mask_assign_bit (param $output i32) (param $position i32) (param $selected i32)
    (local $address i32) (local $bit i32) (local $word i32)
    local.get $output local.get $position i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
    local.set $address
    i32.const 1 local.get $position i32.const 31 i32.and i32.shl local.set $bit
    local.get $address i32.load local.get $bit i32.const -1 i32.xor i32.and local.set $word
    local.get $selected
    if local.get $word local.get $bit i32.or local.set $word end
    local.get $address local.get $word i32.store)

  ;; Sparse payload stores u8 exception positions followed by aligned i32 exception values.
  (func (export "decode_sparse")
    (param $positions i32) (param $values i32) (param $output i32) (param $n i32)
    (param $exception_count i32) (param $default i32)
    (local $index i32) (local $end4 i32) (local $exception i32)
    local.get $n i32.const -4 i32.and local.set $end4
    block $vectors_done loop $vectors
      local.get $index local.get $end4 i32.ge_u br_if $vectors_done
      local.get $output local.get $index i32.const 2 i32.shl i32.add
      local.get $default i32x4.splat v128.store
      local.get $index i32.const 4 i32.add local.set $index br $vectors
    end end
    block $tail_done loop $tail
      local.get $index local.get $n i32.ge_u br_if $tail_done
      local.get $output local.get $index i32.const 2 i32.shl i32.add local.get $default i32.store
      local.get $index i32.const 1 i32.add local.set $index br $tail
    end end
    block $done loop $exceptions
      local.get $exception local.get $exception_count i32.ge_u br_if $done
      local.get $output
      local.get $positions local.get $exception i32.add i32.load8_u i32.const 2 i32.shl i32.add
      local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load i32.store
      local.get $exception i32.const 1 i32.add local.set $exception br $exceptions
    end end)

  (func (export "sum_sparse")
    (param $values i32) (param $n i32) (param $exception_count i32) (param $default i32)
    (result i64)
    (local $exception i32) (local $total i64)
    local.get $default i64.extend_i32_s
    local.get $n local.get $exception_count i32.sub i64.extend_i32_u i64.mul local.set $total
    block $done loop $loop
      local.get $exception local.get $exception_count i32.ge_u br_if $done
      local.get $total
      local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load
      i64.extend_i32_s i64.add local.set $total
      local.get $exception i32.const 1 i32.add local.set $exception br $loop
    end end
    local.get $total)

  (func (export "scan_eq_sparse")
    (param $positions i32) (param $values i32) (param $output i32) (param $n i32)
    (param $exception_count i32) (param $default i32) (param $target i32)
    (local $exception i32) (local $position i32)
    local.get $default local.get $target i32.eq
    if local.get $output local.get $n call $mask_fill_n end
    block $done loop $loop
      local.get $exception local.get $exception_count i32.ge_u br_if $done
      local.get $positions local.get $exception i32.add i32.load8_u local.set $position
      local.get $output local.get $position
      local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load
      local.get $target i32.eq call $mask_assign_bit
      local.get $exception i32.const 1 i32.add local.set $exception br $loop
    end end)

  (func (export "scan_lt_sparse")
    (param $positions i32) (param $values i32) (param $output i32) (param $n i32)
    (param $exception_count i32) (param $default i32) (param $target i32)
    (local $exception i32) (local $position i32)
    local.get $default local.get $target i32.lt_s
    if local.get $output local.get $n call $mask_fill_n end
    block $done loop $loop
      local.get $exception local.get $exception_count i32.ge_u br_if $done
      local.get $positions local.get $exception i32.add i32.load8_u local.set $position
      local.get $output local.get $position
      local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load
      local.get $target i32.lt_s call $mask_assign_bit
      local.get $exception i32.const 1 i32.add local.set $exception br $loop
    end end)

  (func (export "scan_between_sparse")
    (param $positions i32) (param $values i32) (param $output i32) (param $n i32)
    (param $exception_count i32) (param $default i32)
    (param $minimum i32) (param $maximum i32)
    (local $exception i32) (local $position i32) (local $value i32)
    local.get $default local.get $minimum i32.ge_s
    local.get $default local.get $maximum i32.lt_s i32.and
    if local.get $output local.get $n call $mask_fill_n end
    block $done loop $loop
      local.get $exception local.get $exception_count i32.ge_u br_if $done
      local.get $positions local.get $exception i32.add i32.load8_u local.set $position
      local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load local.set $value
      local.get $output local.get $position
      local.get $value local.get $minimum i32.ge_s
      local.get $value local.get $maximum i32.lt_s i32.and call $mask_assign_bit
      local.get $exception i32.const 1 i32.add local.set $exception br $loop
    end end)

  (func (export "gather_sparse")
    (param $positions i32) (param $values i32) (param $mask i32) (param $output i32)
    (param $n i32) (param $exception_count i32) (param $default i32) (result i32)
    (local $index i32) (local $exception i32) (local $written i32) (local $value i32)
    block $done loop $loop
      local.get $index local.get $n i32.ge_u br_if $done
      local.get $default local.set $value
      local.get $exception local.get $exception_count i32.lt_u
      if
        local.get $positions local.get $exception i32.add i32.load8_u local.get $index i32.eq
        if
          local.get $values local.get $exception i32.const 2 i32.shl i32.add i32.load local.set $value
          local.get $exception i32.const 1 i32.add local.set $exception
        end
      end
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
      if
        local.get $output local.get $written i32.const 2 i32.shl i32.add local.get $value i32.store
        local.get $written i32.const 1 i32.add local.set $written
      end
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $written)

  (func $mask_set_range (param $mask i32) (param $start i32) (param $end i32)
    (local $index i32) (local $address i32)
    local.get $start local.set $index
    block $done loop $loop
      local.get $index local.get $end i32.ge_u br_if $done
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
      local.tee $address local.get $address i32.load
      i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.or i32.store
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end)

  ;; RLE payload is an interleaved sequence of (i32 value, u32 end-exclusive).
  (func (export "decode_rle")
    (param $runs i32) (param $output i32) (param $run_count i32)
    (local $run i32) (local $index i32) (local $end i32) (local $value i32)
    (local $address i32)
    block $done loop $run_loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add
      local.tee $address i32.load local.set $value
      local.get $address i32.load offset=4 local.set $end
      block $tail loop $vector_loop
        local.get $index i32.const 4 i32.add local.get $end i32.gt_u br_if $tail
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $value i32x4.splat v128.store
        local.get $index i32.const 4 i32.add local.set $index br $vector_loop
      end end
      block $run_done loop $tail_loop
        local.get $index local.get $end i32.ge_u br_if $run_done
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $value i32.store
        local.get $index i32.const 1 i32.add local.set $index br $tail_loop
      end end
      local.get $run i32.const 1 i32.add local.set $run br $run_loop
    end end)

  (func (export "sum_rle") (param $runs i32) (param $run_count i32) (result i64)
    (local $run i32) (local $start i32) (local $end i32) (local $address i32)
    (local $sum i64)
    block $done loop $loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add local.tee $address
      i32.load i64.extend_i32_s
      local.get $address i32.load offset=4 local.tee $end
      local.get $start i32.sub i64.extend_i32_u i64.mul
      local.get $sum i64.add local.set $sum
      local.get $end local.set $start
      local.get $run i32.const 1 i32.add local.set $run br $loop
    end end
    local.get $sum)

  (func (export "scan_eq_rle")
    (param $runs i32) (param $output i32) (param $run_count i32) (param $target i32)
    (local $run i32) (local $start i32) (local $end i32) (local $address i32)
    block $done loop $loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add local.tee $address
      i32.load local.get $target i32.eq
      local.get $address i32.load offset=4 local.set $end
      if local.get $output local.get $start local.get $end call $mask_set_range end
      local.get $end local.set $start
      local.get $run i32.const 1 i32.add local.set $run br $loop
    end end)

  (func (export "scan_lt_rle")
    (param $runs i32) (param $output i32) (param $run_count i32) (param $target i32)
    (local $run i32) (local $start i32) (local $end i32) (local $address i32)
    block $done loop $loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add local.tee $address
      i32.load local.get $target i32.lt_s
      local.get $address i32.load offset=4 local.set $end
      if local.get $output local.get $start local.get $end call $mask_set_range end
      local.get $end local.set $start
      local.get $run i32.const 1 i32.add local.set $run br $loop
    end end)

  (func (export "scan_between_rle")
    (param $runs i32) (param $output i32) (param $run_count i32)
    (param $minimum i32) (param $maximum i32)
    (local $run i32) (local $start i32) (local $end i32) (local $address i32)
    (local $value i32)
    block $done loop $loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add local.tee $address
      i32.load local.set $value
      local.get $address i32.load offset=4 local.set $end
      local.get $value local.get $minimum i32.ge_s
      local.get $value local.get $maximum i32.lt_s i32.and
      if local.get $output local.get $start local.get $end call $mask_set_range end
      local.get $end local.set $start
      local.get $run i32.const 1 i32.add local.set $run br $loop
    end end)

  (func (export "gather_rle")
    (param $runs i32) (param $mask i32) (param $output i32) (param $run_count i32)
    (result i32)
    (local $run i32) (local $index i32) (local $end i32) (local $value i32)
    (local $address i32) (local $written i32)
    block $done loop $run_loop
      local.get $run local.get $run_count i32.ge_u br_if $done
      local.get $runs local.get $run i32.const 3 i32.shl i32.add local.tee $address
      i32.load local.set $value
      local.get $address i32.load offset=4 local.set $end
      block $run_done loop $index_loop
        local.get $index local.get $end i32.ge_u br_if $run_done
        local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
        i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.and
        if
          local.get $output local.get $written i32.const 2 i32.shl i32.add
          local.get $value i32.store
          local.get $written i32.const 1 i32.add local.set $written
        end
        local.get $index i32.const 1 i32.add local.set $index br $index_loop
      end end
      local.get $run i32.const 1 i32.add local.set $run br $run_loop
    end end
    local.get $written)

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
