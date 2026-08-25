(module
  (memory (export "memory") 1)

  (func $horizontal_popcount (param $value v128) (result i32)
    (local $lanes v128)
    local.get $value i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
    i32x4.extadd_pairwise_i16x8_u local.set $lanes
    local.get $lanes i32x4.extract_lane 0
    local.get $lanes i32x4.extract_lane 1 i32.add
    local.get $lanes i32x4.extract_lane 2 i32.add
    local.get $lanes i32x4.extract_lane 3 i32.add)

  (func (export "row_count") (param $row i32) (param $padded_words i32) (result i32)
    (local $word i32) (local $count i32)
    block $done loop $loop
      local.get $word local.get $padded_words i32.ge_u br_if $done
      local.get $count
      local.get $row local.get $word i32.const 2 i32.shl i32.add v128.load
      call $horizontal_popcount i32.add local.set $count
      local.get $word i32.const 4 i32.add local.set $word br $loop
    end end
    local.get $count)

  (func (export "transpose")
    (param $input i32) (param $output i32) (param $rows i32) (param $columns i32)
    (param $input_stride i32) (param $output_stride i32)
    (local $row i32) (local $column i32) (local $word i32)
    block $rows_done loop $rows_loop
      local.get $row local.get $rows i32.ge_u br_if $rows_done
      i32.const 0 local.set $column
      block $columns_done loop $columns_loop
        local.get $column local.get $columns i32.ge_u br_if $columns_done
        local.get $input
        local.get $row local.get $input_stride i32.mul
        local.get $column i32.const 5 i32.shr_u i32.add i32.const 2 i32.shl i32.add
        i32.load i32.const 1 local.get $column i32.const 31 i32.and i32.shl i32.and
        if
          local.get $output
          local.get $column local.get $output_stride i32.mul
          local.get $row i32.const 5 i32.shr_u i32.add i32.const 2 i32.shl i32.add
          local.tee $word local.get $word i32.load
          i32.const 1 local.get $row i32.const 31 i32.and i32.shl i32.or i32.store
        end
        local.get $column i32.const 1 i32.add local.set $column br $columns_loop
      end end
      local.get $row i32.const 1 i32.add local.set $row br $rows_loop
    end end)

  (func (export "boolean_multiply")
    (param $left i32) (param $right_t i32) (param $output i32)
    (param $rows i32) (param $columns i32) (param $shared_words i32)
    (param $left_stride i32) (param $right_stride i32) (param $output_stride i32)
    (local $row i32) (local $column i32) (local $word i32)
    (local $left_row i32) (local $right_row i32) (local $found i32) (local $out_word i32)
    block $rows_done loop $rows_loop
      local.get $row local.get $rows i32.ge_u br_if $rows_done
      local.get $left local.get $row local.get $left_stride i32.mul i32.const 2 i32.shl i32.add
      local.set $left_row
      i32.const 0 local.set $column
      block $columns_done loop $columns_loop
        local.get $column local.get $columns i32.ge_u br_if $columns_done
        local.get $right_t local.get $column local.get $right_stride i32.mul i32.const 2 i32.shl i32.add
        local.set $right_row
        i32.const 0 local.set $word
        i32.const 0 local.set $found
        block $intersection_done loop $intersection_loop
          local.get $word local.get $shared_words i32.ge_u br_if $intersection_done
          local.get $left_row local.get $word i32.const 2 i32.shl i32.add v128.load
          local.get $right_row local.get $word i32.const 2 i32.shl i32.add v128.load
          v128.and v128.any_true
          if i32.const 1 local.set $found br $intersection_done end
          local.get $word i32.const 4 i32.add local.set $word br $intersection_loop
        end end
        local.get $found
        if
          local.get $output
          local.get $row local.get $output_stride i32.mul
          local.get $column i32.const 5 i32.shr_u i32.add i32.const 2 i32.shl i32.add
          local.tee $out_word local.get $out_word i32.load
          i32.const 1 local.get $column i32.const 31 i32.and i32.shl i32.or i32.store
        end
        local.get $column i32.const 1 i32.add local.set $column br $columns_loop
      end end
      local.get $row i32.const 1 i32.add local.set $row br $rows_loop
    end end)
)
