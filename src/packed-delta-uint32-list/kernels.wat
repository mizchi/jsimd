(module
  (memory (export "memory") 1)

  ;; Build 256 shuffle masks of 16 bytes at the reserved table pointer.
  (func (export "init_shuffle_table") (param $table i32)
    (local $control i32) (local $lane i32) (local $byte i32)
    (local $offset i32) (local $length i32) (local $index i32)
    block $done
      loop $control_loop
        local.get $control i32.const 256 i32.ge_u br_if $done
        i32.const 0 local.set $offset
        i32.const 0 local.set $lane
        block $lanes_done
          loop $lane_loop
            local.get $lane i32.const 4 i32.ge_u br_if $lanes_done
            local.get $control local.get $lane i32.const 1 i32.shl i32.shr_u
            i32.const 3 i32.and i32.const 1 i32.add local.set $length
            i32.const 0 local.set $byte
            block $bytes_done
              loop $byte_loop
                local.get $byte i32.const 4 i32.ge_u br_if $bytes_done
                local.get $byte local.get $length i32.lt_u
                if
                  local.get $offset local.get $byte i32.add local.set $index
                else
                  i32.const 128 local.set $index
                end
                local.get $table
                local.get $control i32.const 4 i32.shl i32.add
                local.get $lane i32.const 2 i32.shl i32.add
                local.get $byte i32.add
                local.get $index i32.store8
                local.get $byte i32.const 1 i32.add local.set $byte br $byte_loop
              end
            end
            local.get $offset local.get $length i32.add local.set $offset
            local.get $lane i32.const 1 i32.add local.set $lane br $lane_loop
          end
        end
        local.get $control i32.const 1 i32.add local.set $control br $control_loop
      end
    end
  )

  (func $data_length (param $control i32) (result i32)
    i32.const 4
    local.get $control i32.const 3 i32.and i32.add
    local.get $control i32.const 2 i32.shr_u i32.const 3 i32.and i32.add
    local.get $control i32.const 4 i32.shr_u i32.const 3 i32.and i32.add
    local.get $control i32.const 6 i32.shr_u i32.const 3 i32.and i32.add
  )

  (func $decode_deltas (param $data i32) (param $control i32) (result v128)
    local.get $data v128.load
    local.get $control i32.const 4 i32.shl v128.load
    i8x16.swizzle
  )

  (func $decode_group (param $data i32) (param $control i32) (param $base i32) (result v128)
    (local $deltas v128) (local $values v128)
    local.get $data local.get $control call $decode_deltas local.set $deltas
    local.get $deltas
    v128.const i32x4 0 0 0 0
    local.get $deltas
    i8x16.shuffle 0 1 2 3 16 17 18 19 20 21 22 23 24 25 26 27
    i32x4.add local.tee $values
    v128.const i32x4 0 0 0 0
    local.get $values
    i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
    i32x4.add
    local.get $base i32x4.splat i32x4.add
  )

  (func $extract_lane (param $values v128) (param $lane i32) (result i32)
    local.get $lane i32.eqz
    if (result i32) local.get $values i32x4.extract_lane 0
    else
      local.get $lane i32.const 1 i32.eq
      if (result i32) local.get $values i32x4.extract_lane 1
      else
        local.get $lane i32.const 2 i32.eq
        if (result i32) local.get $values i32x4.extract_lane 2
        else local.get $values i32x4.extract_lane 3
        end
      end
    end
  )

  (func $at32
    (param $data i32) (param $controls i32) (param $checkpoints i32) (param $index i32)
    (result i32)
    (local $block i32) (local $target_group i32) (local $lane i32) (local $group i32)
    (local $data_offset i32) (local $base i32) (local $control i32) (local $values v128)
    local.get $index i32.const 7 i32.shr_u local.tee $block
    i32.const 5 i32.shl local.set $group
    local.get $index i32.const 127 i32.and i32.const 2 i32.shr_u local.set $target_group
    local.get $index i32.const 3 i32.and local.set $lane
    local.get $checkpoints local.get $block i32.const 3 i32.shl i32.add
    i32.load local.set $data_offset
    local.get $checkpoints local.get $block i32.const 3 i32.shl i32.add
    i32.const 4 i32.add i32.load local.set $base
    i32.const 0 local.set $block
    block $unreachable
      loop $group_loop
        local.get $controls local.get $group i32.add i32.load8_u local.set $control
        local.get $data local.get $data_offset i32.add local.get $control local.get $base
        call $decode_group local.set $values
        local.get $block local.get $target_group i32.eq
        if local.get $values local.get $lane call $extract_lane return end
        local.get $values i32x4.extract_lane 3 local.set $base
        local.get $data_offset local.get $control call $data_length i32.add local.set $data_offset
        local.get $group i32.const 1 i32.add local.set $group
        local.get $block i32.const 1 i32.add local.set $block
        br $group_loop
      end
    end
    i32.const 0
  )

  (func (export "at")
    (param $data i32) (param $controls i32) (param $checkpoints i32) (param $index i32)
    (result i64)
    local.get $data local.get $controls local.get $checkpoints local.get $index
    call $at32 i64.extend_i32_u
  )

  (func (export "lower_bound")
    (param $data i32) (param $controls i32) (param $checkpoints i32)
    (param $length i32) (param $target i32) (result i32)
    (local $blocks i32) (local $low i32) (local $high i32) (local $mid i32)
    (local $position i32) (local $group i32) (local $group_end i32) (local $lane i32)
    (local $data_offset i32) (local $base i32) (local $control i32)
    (local $values v128) (local $value i32)
    local.get $length i32.eqz if i32.const 0 return end
    local.get $length i32.const 127 i32.add i32.const 7 i32.shr_u local.tee $blocks
    local.set $high
    block $search_done
      loop $search_loop
        local.get $low local.get $high i32.ge_u br_if $search_done
        local.get $low local.get $high i32.add i32.const 1 i32.shr_u local.set $mid
        local.get $checkpoints local.get $mid i32.const 1 i32.add
        i32.const 3 i32.shl i32.add i32.const 4 i32.add i32.load
        local.get $target i32.lt_u
        if
          local.get $mid i32.const 1 i32.add local.set $low
        else
          local.get $mid local.set $high
        end
        br $search_loop
      end
    end
    local.get $low local.get $blocks i32.ge_u if local.get $length return end
    local.get $low i32.const 7 i32.shl local.set $position
    local.get $low i32.const 5 i32.shl local.tee $group
    i32.const 32 i32.add local.set $group_end
    local.get $checkpoints local.get $low i32.const 3 i32.shl i32.add
    i32.load local.set $data_offset
    local.get $checkpoints local.get $low i32.const 3 i32.shl i32.add
    i32.const 4 i32.add i32.load local.set $base
    block $not_found
      loop $group_loop
        local.get $group local.get $group_end i32.ge_u br_if $not_found
        local.get $controls local.get $group i32.add i32.load8_u local.set $control
        local.get $data local.get $data_offset i32.add local.get $control local.get $base
        call $decode_group local.set $values
        i32.const 0 local.set $lane
        block $lanes_done
          loop $lane_loop
            local.get $lane i32.const 4 i32.ge_u br_if $lanes_done
            local.get $position local.get $length i32.ge_u if local.get $length return end
            local.get $values local.get $lane call $extract_lane local.tee $value
            local.get $target i32.ge_u if local.get $position return end
            local.get $position i32.const 1 i32.add local.set $position
            local.get $lane i32.const 1 i32.add local.set $lane br $lane_loop
          end
        end
        local.get $values i32x4.extract_lane 3 local.set $base
        local.get $data_offset local.get $control call $data_length i32.add local.set $data_offset
        local.get $group i32.const 1 i32.add local.set $group br $group_loop
      end
    end
    local.get $length
  )

  (func (export "decode_range")
    (param $data i32) (param $controls i32) (param $checkpoints i32)
    (param $length i32) (param $start i32) (param $output i32) (param $output_length i32)
    (result i32)
    (local $block i32) (local $position i32) (local $group i32) (local $lane i32)
    (local $data_offset i32) (local $base i32) (local $control i32)
    (local $values v128) (local $value i32) (local $written i32)
    local.get $start local.get $length i32.ge_u if i32.const 0 return end
    local.get $output_length i32.eqz if i32.const 0 return end
    local.get $start i32.const 7 i32.shr_u local.tee $block
    i32.const 7 i32.shl local.set $position
    local.get $block i32.const 5 i32.shl local.set $group
    local.get $checkpoints local.get $block i32.const 3 i32.shl i32.add
    i32.load local.set $data_offset
    local.get $checkpoints local.get $block i32.const 3 i32.shl i32.add
    i32.const 4 i32.add i32.load local.set $base
    block $done
      loop $group_loop
        local.get $position local.get $length i32.ge_u br_if $done
        local.get $controls local.get $group i32.add i32.load8_u local.set $control
        local.get $data local.get $data_offset i32.add local.get $control local.get $base
        call $decode_group local.set $values
        i32.const 0 local.set $lane
        block $lanes_done
          loop $lane_loop
            local.get $lane i32.const 4 i32.ge_u br_if $lanes_done
            local.get $position local.get $length i32.ge_u br_if $done
            local.get $values local.get $lane call $extract_lane local.set $value
            local.get $position local.get $start i32.ge_u
            if
              local.get $output local.get $written i32.const 2 i32.shl i32.add
              local.get $value i32.store
              local.get $written i32.const 1 i32.add local.tee $written
              local.get $output_length i32.ge_u br_if $done
            end
            local.get $position i32.const 1 i32.add local.set $position
            local.get $lane i32.const 1 i32.add local.set $lane br $lane_loop
          end
        end
        local.get $values i32x4.extract_lane 3 local.set $base
        local.get $data_offset local.get $control call $data_length i32.add local.set $data_offset
        local.get $group i32.const 1 i32.add local.set $group br $group_loop
      end
    end
    local.get $written
  )

  (func (export "intersect_into")
    (param $left_data i32) (param $left_controls i32) (param $left_length i32)
    (param $right_data i32) (param $right_controls i32) (param $right_length i32)
    (param $output i32) (param $output_length i32) (result i32)
    (local $left_position i32) (local $right_position i32)
    (local $left_group i32) (local $right_group i32)
    (local $left_base i32) (local $right_base i32)
    (local $left_control i32) (local $right_control i32)
    (local $left_valid i32) (local $right_valid i32)
    (local $left_values v128) (local $right_values v128)
    (local $left_last i32) (local $right_last i32)
    (local $lane i32) (local $value i32) (local $written i32)
    local.get $output_length i32.eqz if i32.const 0 return end
    block $done
      loop $loop
        local.get $left_position local.get $left_length i32.ge_u br_if $done
        local.get $right_position local.get $right_length i32.ge_u br_if $done

        local.get $left_data
        local.get $left_controls local.get $left_group i32.add i32.load8_u
        local.tee $left_control
        local.get $left_base
        call $decode_group
        local.set $left_values
        local.get $right_data
        local.get $right_controls local.get $right_group i32.add i32.load8_u
        local.tee $right_control
        local.get $right_base
        call $decode_group
        local.set $right_values

        local.get $left_length local.get $left_position i32.sub local.tee $left_valid
        i32.const 4 i32.gt_u if i32.const 4 local.set $left_valid end
        local.get $right_length local.get $right_position i32.sub local.tee $right_valid
        i32.const 4 i32.gt_u if i32.const 4 local.set $right_valid end

        i32.const 0 local.set $lane
        block $lanes_done
          loop $lane_loop
            local.get $lane local.get $left_valid i32.ge_u br_if $lanes_done
            local.get $left_values local.get $lane call $extract_lane local.tee $value
            i32x4.splat local.get $right_values i32x4.eq i8x16.bitmask
            i32.eqz
            if
            else
              local.get $output local.get $written i32.const 2 i32.shl i32.add
              local.get $value i32.store
              local.get $written i32.const 1 i32.add local.tee $written
              local.get $output_length i32.ge_u br_if $done
            end
            local.get $lane i32.const 1 i32.add local.set $lane
            br $lane_loop
          end
        end

        local.get $left_values local.get $left_valid i32.const 1 i32.sub
        call $extract_lane local.set $left_last
        local.get $right_values local.get $right_valid i32.const 1 i32.sub
        call $extract_lane local.set $right_last

        local.get $left_last local.get $right_last i32.le_u
        if
          local.get $left_data local.get $left_control call $data_length i32.add
          local.set $left_data
          local.get $left_values i32x4.extract_lane 3 local.set $left_base
          local.get $left_group i32.const 1 i32.add local.set $left_group
          local.get $left_position local.get $left_valid i32.add local.set $left_position
        end
        local.get $left_last local.get $right_last i32.ge_u
        if
          local.get $right_data local.get $right_control call $data_length i32.add
          local.set $right_data
          local.get $right_values i32x4.extract_lane 3 local.set $right_base
          local.get $right_group i32.const 1 i32.add local.set $right_group
          local.get $right_position local.get $right_valid i32.add local.set $right_position
        end
        br $loop
      end
    end
    local.get $written
  )
)
