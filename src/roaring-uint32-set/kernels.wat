(module
  (memory (export "memory") 1)

  (func $horizontal_popcount (param $value v128) (result i32)
    (local $lanes v128)
    local.get $value i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
    i32x4.extadd_pairwise_i16x8_u local.set $lanes
    local.get $lanes i32x4.extract_lane 0
    local.get $lanes i32x4.extract_lane 1 i32.add
    local.get $lanes i32x4.extract_lane 2 i32.add
    local.get $lanes i32x4.extract_lane 3 i32.add
  )

  (func (export "bitmap_and_count") (param $left i32) (param $right i32) (result i32)
    (local $offset i32) (local $count i32)
    block $done
      loop $loop
        local.get $offset i32.const 8192 i32.ge_u br_if $done
        local.get $count
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.and
        call $horizontal_popcount i32.add local.set $count
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
    local.get $count
  )

  (func (export "bitmap_intersects") (param $left i32) (param $right i32) (result i32)
    (local $offset i32)
    block $done
      loop $loop
        local.get $offset i32.const 8192 i32.ge_u br_if $done
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.and v128.any_true
        if i32.const 1 return end
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
    i32.const 0
  )

  (func (export "bitmap_and_into")
    (param $left i32) (param $right i32) (param $output i32) (result i32)
    (local $offset i32) (local $value v128) (local $count i32)
    block $done
      loop $loop
        local.get $offset i32.const 8192 i32.ge_u br_if $done
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.and local.set $value
        local.get $output local.get $offset i32.add local.get $value v128.store
        local.get $count local.get $value call $horizontal_popcount i32.add local.set $count
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
    local.get $count
  )

  (func (export "array_array_count")
    (param $left i32) (param $left_length i32)
    (param $right i32) (param $right_length i32) (result i32)
    (local $i i32) (local $j i32) (local $a i32) (local $b i32) (local $count i32)
    block $done
      loop $loop
        local.get $i local.get $left_length i32.ge_u br_if $done
        local.get $j local.get $right_length i32.ge_u br_if $done
        local.get $left local.get $i i32.const 1 i32.shl i32.add i32.load16_u local.set $a
        local.get $right local.get $j i32.const 1 i32.shl i32.add i32.load16_u local.set $b
        local.get $a local.get $b i32.eq
        if
          local.get $count i32.const 1 i32.add local.set $count
          local.get $i i32.const 1 i32.add local.set $i
          local.get $j i32.const 1 i32.add local.set $j
        else
          local.get $a local.get $b i32.lt_u
          if
            local.get $i i32.const 1 i32.add local.set $i
          else
            local.get $j i32.const 1 i32.add local.set $j
          end
        end
        br $loop
      end
    end
    local.get $count
  )

  (func (export "array_array_intersects")
    (param $left i32) (param $left_length i32)
    (param $right i32) (param $right_length i32) (result i32)
    (local $i i32) (local $j i32) (local $a i32) (local $b i32)
    block $done
      loop $loop
        local.get $i local.get $left_length i32.ge_u br_if $done
        local.get $j local.get $right_length i32.ge_u br_if $done
        local.get $left local.get $i i32.const 1 i32.shl i32.add i32.load16_u local.set $a
        local.get $right local.get $j i32.const 1 i32.shl i32.add i32.load16_u local.set $b
        local.get $a local.get $b i32.eq
        if i32.const 1 return end
        local.get $a local.get $b i32.lt_u
        if
          local.get $i i32.const 1 i32.add local.set $i
        else
          local.get $j i32.const 1 i32.add local.set $j
        end
        br $loop
      end
    end
    i32.const 0
  )

  (func (export "array_array_and_into")
    (param $left i32) (param $left_length i32)
    (param $right i32) (param $right_length i32) (param $output i32) (result i32)
    (local $i i32) (local $j i32) (local $a i32) (local $b i32) (local $count i32)
    block $done
      loop $loop
        local.get $i local.get $left_length i32.ge_u br_if $done
        local.get $j local.get $right_length i32.ge_u br_if $done
        local.get $left local.get $i i32.const 1 i32.shl i32.add i32.load16_u local.set $a
        local.get $right local.get $j i32.const 1 i32.shl i32.add i32.load16_u local.set $b
        local.get $a local.get $b i32.eq
        if
          local.get $output local.get $count i32.const 1 i32.shl i32.add
          local.get $a i32.store16
          local.get $count i32.const 1 i32.add local.set $count
          local.get $i i32.const 1 i32.add local.set $i
          local.get $j i32.const 1 i32.add local.set $j
        else
          local.get $a local.get $b i32.lt_u
          if
            local.get $i i32.const 1 i32.add local.set $i
          else
            local.get $j i32.const 1 i32.add local.set $j
          end
        end
        br $loop
      end
    end
    local.get $count
  )

  (func $bitmap_has (param $bitmap i32) (param $value i32) (result i32)
    local.get $bitmap local.get $value i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
    i32.load i32.const 1 local.get $value i32.const 31 i32.and i32.shl i32.and i32.eqz i32.eqz
  )

  (func (export "array_bitmap_count")
    (param $array i32) (param $length i32) (param $bitmap i32) (result i32)
    (local $i i32) (local $count i32)
    block $done
      loop $loop
        local.get $i local.get $length i32.ge_u br_if $done
        local.get $count
        local.get $bitmap
        local.get $array local.get $i i32.const 1 i32.shl i32.add i32.load16_u
        call $bitmap_has i32.add local.set $count
        local.get $i i32.const 1 i32.add local.set $i br $loop
      end
    end
    local.get $count
  )

  (func (export "array_bitmap_intersects")
    (param $array i32) (param $length i32) (param $bitmap i32) (result i32)
    (local $i i32)
    block $done
      loop $loop
        local.get $i local.get $length i32.ge_u br_if $done
        local.get $bitmap
        local.get $array local.get $i i32.const 1 i32.shl i32.add i32.load16_u
        call $bitmap_has
        if i32.const 1 return end
        local.get $i i32.const 1 i32.add local.set $i br $loop
      end
    end
    i32.const 0
  )

  (func (export "array_bitmap_and_into")
    (param $array i32) (param $length i32) (param $bitmap i32)
    (param $output i32) (result i32)
    (local $i i32) (local $value i32) (local $count i32)
    block $done
      loop $loop
        local.get $i local.get $length i32.ge_u br_if $done
        local.get $array local.get $i i32.const 1 i32.shl i32.add
        i32.load16_u local.set $value
        local.get $bitmap local.get $value call $bitmap_has
        if
          local.get $output local.get $count i32.const 1 i32.shl i32.add
          local.get $value i32.store16
          local.get $count i32.const 1 i32.add local.set $count
        end
        local.get $i i32.const 1 i32.add local.set $i br $loop
      end
    end
    local.get $count
  )
)
