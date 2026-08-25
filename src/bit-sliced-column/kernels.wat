(module
  (memory (export "memory") 1)

  (func $lt_block
    (param $planes i32) (param $validity i32) (param $word_offset i32)
    (param $plane_stride i32) (param $bit_width i32) (param $value i32)
    (result v128)
    (local $bit i32) (local $equal v128) (local $less v128) (local $plane v128)
    local.get $value i32.eqz
    if v128.const i32x4 0 0 0 0 return end
    local.get $value i32.const 1 local.get $bit_width i32.shl i32.ge_u
    if
      local.get $validity local.get $word_offset i32.const 2 i32.shl i32.add v128.load return
    end
    local.get $validity local.get $word_offset i32.const 2 i32.shl i32.add v128.load
    local.set $equal
    local.get $bit_width i32.const 1 i32.sub local.set $bit
    block $done
      loop $bits
        local.get $bit i32.const 0 i32.lt_s br_if $done
        local.get $planes
        local.get $bit local.get $plane_stride i32.mul i32.add
        local.get $word_offset i32.const 2 i32.shl i32.add v128.load local.set $plane
        local.get $value local.get $bit i32.shr_u i32.const 1 i32.and
        if
          local.get $less local.get $equal local.get $plane v128.andnot v128.or local.set $less
          local.get $equal local.get $plane v128.and local.set $equal
        else
          local.get $equal local.get $plane v128.andnot local.set $equal
        end
        local.get $bit i32.const 1 i32.sub local.set $bit br $bits
      end
    end
    local.get $less
  )

  (func (export "scan_eq")
    (param $planes i32) (param $validity i32) (param $output i32)
    (param $word_count i32) (param $bit_width i32) (param $value i32)
    (local $word i32) (local $bit i32) (local $stride i32)
    (local $result v128) (local $plane v128)
    local.get $word_count i32.const 2 i32.shl local.set $stride
    block $done
      loop $words
        local.get $word local.get $word_count i32.ge_u br_if $done
        local.get $validity local.get $word i32.const 2 i32.shl i32.add v128.load
        local.set $result
        i32.const 0 local.set $bit
        block $bits_done
          loop $bits
            local.get $bit local.get $bit_width i32.ge_u br_if $bits_done
            local.get $planes
            local.get $bit local.get $stride i32.mul i32.add
            local.get $word i32.const 2 i32.shl i32.add v128.load local.set $plane
            local.get $value local.get $bit i32.shr_u i32.const 1 i32.and
            if
              local.get $result local.get $plane v128.and local.set $result
            else
              local.get $result local.get $plane v128.andnot local.set $result
            end
            local.get $bit i32.const 1 i32.add local.set $bit br $bits
          end
        end
        local.get $output local.get $word i32.const 2 i32.shl i32.add
        local.get $result v128.store
        local.get $word i32.const 4 i32.add local.set $word br $words
      end
    end
  )

  (func (export "scan_lt")
    (param $planes i32) (param $validity i32) (param $output i32)
    (param $word_count i32) (param $bit_width i32) (param $value i32)
    (local $word i32) (local $stride i32)
    local.get $word_count i32.const 2 i32.shl local.set $stride
    block $done
      loop $words
        local.get $word local.get $word_count i32.ge_u br_if $done
        local.get $output local.get $word i32.const 2 i32.shl i32.add
        local.get $planes local.get $validity local.get $word local.get $stride
        local.get $bit_width local.get $value call $lt_block v128.store
        local.get $word i32.const 4 i32.add local.set $word br $words
      end
    end
  )

  (func (export "scan_between")
    (param $planes i32) (param $validity i32) (param $output i32)
    (param $word_count i32) (param $bit_width i32) (param $minimum i32) (param $maximum_exclusive i32)
    (local $word i32) (local $stride i32) (local $below_minimum v128) (local $below_maximum v128)
    local.get $word_count i32.const 2 i32.shl local.set $stride
    block $done
      loop $words
        local.get $word local.get $word_count i32.ge_u br_if $done
        local.get $planes local.get $validity local.get $word local.get $stride
        local.get $bit_width local.get $minimum call $lt_block local.set $below_minimum
        local.get $planes local.get $validity local.get $word local.get $stride
        local.get $bit_width local.get $maximum_exclusive call $lt_block local.set $below_maximum
        local.get $output local.get $word i32.const 2 i32.shl i32.add
        local.get $below_maximum local.get $below_minimum v128.andnot v128.store
        local.get $word i32.const 4 i32.add local.set $word br $words
      end
    end
  )

  (func (export "mask_and") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load
      v128.and v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_or") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load
      v128.or v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_andnot") (param $left i32) (param $right i32) (param $word_count i32)
    (local $word i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $left local.get $word i32.const 2 i32.shl i32.add
      local.get $left local.get $word i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $word i32.const 2 i32.shl i32.add v128.load
      v128.andnot v128.store
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
  )

  (func (export "mask_count") (param $pointer i32) (param $word_count i32) (result i32)
    (local $word i32) (local $bytes v128) (local $pairs v128) (local $quads v128) (local $count i32)
    block $done loop $loop
      local.get $word local.get $word_count i32.ge_u br_if $done
      local.get $pointer local.get $word i32.const 2 i32.shl i32.add v128.load
      i8x16.popcnt local.set $bytes
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
