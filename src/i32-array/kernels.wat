(module
  (memory (export "memory") 1)

  ;; Accumulate four i32 lanes into two signed i64 lane pairs to avoid i32 overflow.
  (func (export "sum") (param $ptr i32) (param $n i32) (result i64)
    (local $i i32) (local $end4 i32) (local $chunk v128)
    (local $low v128) (local $high v128) (local $total i64)
    local.get $n i32.const -4 i32.and local.set $end4
    block $vector_done
      loop $vector
        local.get $i local.get $end4 i32.ge_u br_if $vector_done
        local.get $ptr local.get $i i32.const 2 i32.shl i32.add v128.load local.set $chunk
        local.get $low local.get $chunk i64x2.extend_low_i32x4_s i64x2.add local.set $low
        local.get $high local.get $chunk i64x2.extend_high_i32x4_s i64x2.add local.set $high
        local.get $i i32.const 4 i32.add local.set $i br $vector
      end
    end
    local.get $low i64x2.extract_lane 0
    local.get $low i64x2.extract_lane 1 i64.add
    local.get $high i64x2.extract_lane 0 i64.add
    local.get $high i64x2.extract_lane 1 i64.add local.set $total
    block $done
      loop $tail
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $total
        local.get $ptr local.get $i i32.const 2 i32.shl i32.add i32.load i64.extend_i32_s
        i64.add local.set $total
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    local.get $total
  )

  (func (export "min") (param $ptr i32) (param $n i32) (result i32)
    (local $i i32) (local $best i32) (local $vector_best v128)
    local.get $n i32.const 4 i32.ge_u
    if
      local.get $ptr v128.load local.set $vector_best
      i32.const 4 local.set $i
      block $vector_done
        loop $vector
          local.get $i i32.const 4 i32.add local.get $n i32.gt_u br_if $vector_done
          local.get $vector_best
          local.get $ptr local.get $i i32.const 2 i32.shl i32.add v128.load
          i32x4.min_s local.set $vector_best
          local.get $i i32.const 4 i32.add local.set $i br $vector
        end
      end
      local.get $vector_best i32x4.extract_lane 0 local.set $best
      local.get $vector_best i32x4.extract_lane 1 local.get $best i32.lt_s
      if local.get $vector_best i32x4.extract_lane 1 local.set $best end
      local.get $vector_best i32x4.extract_lane 2 local.get $best i32.lt_s
      if local.get $vector_best i32x4.extract_lane 2 local.set $best end
      local.get $vector_best i32x4.extract_lane 3 local.get $best i32.lt_s
      if local.get $vector_best i32x4.extract_lane 3 local.set $best end
    else
      local.get $ptr i32.load local.set $best
      i32.const 1 local.set $i
    end
    block $done
      loop $tail
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $ptr local.get $i i32.const 2 i32.shl i32.add i32.load
        local.get $best i32.lt_s
        if local.get $ptr local.get $i i32.const 2 i32.shl i32.add i32.load local.set $best end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    local.get $best
  )

  (func (export "max") (param $ptr i32) (param $n i32) (result i32)
    (local $i i32) (local $best i32) (local $vector_best v128)
    local.get $n i32.const 4 i32.ge_u
    if
      local.get $ptr v128.load local.set $vector_best
      i32.const 4 local.set $i
      block $vector_done
        loop $vector
          local.get $i i32.const 4 i32.add local.get $n i32.gt_u br_if $vector_done
          local.get $vector_best
          local.get $ptr local.get $i i32.const 2 i32.shl i32.add v128.load
          i32x4.max_s local.set $vector_best
          local.get $i i32.const 4 i32.add local.set $i br $vector
        end
      end
      local.get $vector_best i32x4.extract_lane 0 local.set $best
      local.get $vector_best i32x4.extract_lane 1 local.get $best i32.gt_s
      if local.get $vector_best i32x4.extract_lane 1 local.set $best end
      local.get $vector_best i32x4.extract_lane 2 local.get $best i32.gt_s
      if local.get $vector_best i32x4.extract_lane 2 local.set $best end
      local.get $vector_best i32x4.extract_lane 3 local.get $best i32.gt_s
      if local.get $vector_best i32x4.extract_lane 3 local.set $best end
    else
      local.get $ptr i32.load local.set $best
      i32.const 1 local.set $i
    end
    block $done
      loop $tail
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $ptr local.get $i i32.const 2 i32.shl i32.add i32.load
        local.get $best i32.gt_s
        if local.get $ptr local.get $i i32.const 2 i32.shl i32.add i32.load local.set $best end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    local.get $best
  )

  (func (export "equal") (param $left i32) (param $right i32)
    (param $n i32) (result i32)
    (local $i i32)
    block $equal
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $equal
        local.get $left local.get $i i32.const 2 i32.shl i32.add v128.load
        local.get $right local.get $i i32.const 2 i32.shl i32.add v128.load
        v128.xor v128.any_true
        if i32.const 0 return end
        local.get $i i32.const 4 i32.add local.set $i br $loop
      end
    end
    i32.const 1
  )

  (func (export "add") (param $target i32) (param $source i32) (param $n i32)
    (local $i i32)
    block $done
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $target local.get $i i32.const 2 i32.shl i32.add
        local.get $target local.get $i i32.const 2 i32.shl i32.add v128.load
        local.get $source local.get $i i32.const 2 i32.shl i32.add v128.load
        i32x4.add v128.store
        local.get $i i32.const 4 i32.add local.set $i br $loop
      end
    end
  )
)
