(module
  (import "jsimd" "memory" (memory 1))

  (func $density (param $material i32) (result i32)
    local.get $material
    i32.const 2
    i32.eq
    if (result i32)
      i32.const 2
    else
      local.get $material
      i32.const 3
      i32.eq
      if (result i32)
        i32.const 1
      else
        local.get $material
        i32.const 4
        i32.eq
        if (result i32)
          i32.const -1
        else
          i32.const 0
        end
      end
    end)

  (func $should_fall (param $top i32) (param $bottom i32) (result i32)
    (local $top_material i32)
    (local $bottom_material i32)
    local.get $top
    i32.const 255
    i32.and
    local.tee $top_material
    i32.const 1
    i32.eq
    if
      i32.const 0
      return
    end
    local.get $bottom
    i32.const 255
    i32.and
    local.tee $bottom_material
    i32.const 1
    i32.eq
    if
      i32.const 0
      return
    end
    local.get $top_material
    call $density
    local.get $bottom_material
    call $density
    i32.gt_s)

  (func $is_fluid (param $material i32) (result i32)
    local.get $material
    i32.const 3
    i32.eq
    local.get $material
    i32.const 4
    i32.eq
    i32.or)

  (func $should_flow_right (param $left i32) (param $right i32) (result i32)
    local.get $left
    i32.const 255
    i32.and
    call $is_fluid
    local.get $right
    i32.const 255
    i32.and
    i32.eqz
    i32.and)

  (func $should_flow_left (param $left i32) (param $right i32) (result i32)
    local.get $left
    i32.const 255
    i32.and
    i32.eqz
    local.get $right
    i32.const 255
    i32.and
    call $is_fluid
    i32.and)

  (func $block_random
    (param $seed i32)
    (param $tick i32)
    (param $block_x i32)
    (param $block_y i32)
    (result i32)
    (local $value i32)
    local.get $seed
    local.get $tick
    i32.const 1
    i32.add
    i32.const 0x9e3779b9
    i32.mul
    i32.xor
    local.get $block_y
    i32.const 0x10001
    i32.mul
    local.get $block_x
    i32.add
    i32.const 1
    i32.add
    i32.const 0x85ebca6b
    i32.mul
    i32.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 13
    i32.shl
    i32.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 17
    i32.shr_u
    i32.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 5
    i32.shl
    i32.xor)

  ;; Finish diagonal and horizontal rules after a vertical exchange. vertical_mask uses one bit
  ;; per column. The caller has already counted and stored those vertical moves.
  (func $finish_block
    (param $cells i32)
    (param $width i32)
    (param $tick i32)
    (param $seed i32)
    (param $block_x i32)
    (param $block_y i32)
    (param $top_left i32)
    (param $vertical_mask i32)
    (result i32)
    (local $top_right i32)
    (local $bottom_left i32)
    (local $bottom_right i32)
    (local $a i32)
    (local $b i32)
    (local $c i32)
    (local $d i32)
    (local $value i32)
    (local $moved i32)
    (local $moves i32)
    (local $random i32)

    local.get $top_left
    i32.const 4
    i32.add
    local.set $top_right
    local.get $top_left
    local.get $width
    i32.const 2
    i32.shl
    i32.add
    local.set $bottom_left
    local.get $bottom_left
    i32.const 4
    i32.add
    local.set $bottom_right

    local.get $top_left
    i32.load
    local.set $a
    local.get $top_right
    i32.load
    local.set $b
    local.get $bottom_left
    i32.load
    local.set $c
    local.get $bottom_right
    i32.load
    local.set $d

    local.get $a
    local.get $b
    i32.or
    local.get $c
    i32.or
    local.get $d
    i32.or
    i32.const 254
    i32.and
    i32.eqz
    if
      i32.const 0
      return
    end

    local.get $vertical_mask
    i32.const 1
    i32.and
    if
      local.get $moved
      i32.const 5
      i32.or
      local.set $moved
    end
    local.get $vertical_mask
    i32.const 2
    i32.and
    if
      local.get $moved
      i32.const 10
      i32.or
      local.set $moved
    end
    local.get $moved
    i32.const 15
    i32.eq
    if
      i32.const 0
      return
    end

    local.get $seed
    local.get $tick
    local.get $block_x
    local.get $block_y
    call $block_random
    local.set $random

    local.get $random
    i32.const 3
    i32.and
    i32.eqz
    i32.eqz
    local.get $moved
    i32.const 9
    i32.and
    i32.eqz
    i32.and
    local.get $a
    local.get $d
    call $should_fall
    i32.and
    if
      local.get $a
      local.set $value
      local.get $d
      local.set $a
      local.get $value
      local.set $d
      local.get $moved
      i32.const 9
      i32.or
      local.set $moved
      local.get $moves
      i32.const 1
      i32.add
      local.set $moves
    end

    local.get $random
    i32.const 2
    i32.shr_u
    i32.const 3
    i32.and
    i32.eqz
    i32.eqz
    local.get $moved
    i32.const 6
    i32.and
    i32.eqz
    i32.and
    local.get $b
    local.get $c
    call $should_fall
    i32.and
    if
      local.get $b
      local.set $value
      local.get $c
      local.set $b
      local.get $value
      local.set $c
      local.get $moved
      i32.const 6
      i32.or
      local.set $moved
      local.get $moves
      i32.const 1
      i32.add
      local.set $moves
    end

    local.get $moved
    i32.const 3
    i32.and
    i32.eqz
    if
      local.get $random
      i32.const 16
      i32.and
      i32.eqz
      if (result i32)
        local.get $a
        local.get $b
        call $should_flow_right
      else
        local.get $a
        local.get $b
        call $should_flow_left
      end
      if
        local.get $a
        local.set $value
        local.get $b
        local.set $a
        local.get $value
        local.set $b
        local.get $moved
        i32.const 3
        i32.or
        local.set $moved
        local.get $moves
        i32.const 1
        i32.add
        local.set $moves
      end
    end

    local.get $moved
    i32.const 12
    i32.and
    i32.eqz
    if
      local.get $random
      i32.const 32
      i32.and
      i32.eqz
      if (result i32)
        local.get $c
        local.get $d
        call $should_flow_right
      else
        local.get $c
        local.get $d
        call $should_flow_left
      end
      if
        local.get $c
        local.set $value
        local.get $d
        local.set $c
        local.get $value
        local.set $d
        local.get $moves
        i32.const 1
        i32.add
        local.set $moves
      end
    end

    local.get $top_left
    local.get $a
    i32.store
    local.get $top_right
    local.get $b
    i32.store
    local.get $bottom_left
    local.get $c
    i32.store
    local.get $bottom_right
    local.get $d
    i32.store
    local.get $moves)

  (func $step_scalar_block
    (param $cells i32)
    (param $width i32)
    (param $tick i32)
    (param $seed i32)
    (param $block_x i32)
    (param $block_y i32)
    (param $top_left i32)
    (result i32)
    (local $bottom_left i32)
    (local $top i32)
    (local $bottom i32)
    (local $mask i32)
    (local $moves i32)
    local.get $top_left
    local.get $width
    i32.const 2
    i32.shl
    i32.add
    local.set $bottom_left

    local.get $top_left
    i32.load
    local.set $top
    local.get $bottom_left
    i32.load
    local.set $bottom
    local.get $top
    local.get $bottom
    call $should_fall
    if
      local.get $top_left
      local.get $bottom
      i32.store
      local.get $bottom_left
      local.get $top
      i32.store
      i32.const 1
      local.set $mask
      i32.const 1
      local.set $moves
    end

    local.get $top_left
    i32.const 4
    i32.add
    i32.load
    local.set $top
    local.get $bottom_left
    i32.const 4
    i32.add
    i32.load
    local.set $bottom
    local.get $top
    local.get $bottom
    call $should_fall
    if
      local.get $top_left
      i32.const 4
      i32.add
      local.get $bottom
      i32.store
      local.get $bottom_left
      i32.const 4
      i32.add
      local.get $top
      i32.store
      local.get $mask
      i32.const 2
      i32.or
      local.set $mask
      local.get $moves
      i32.const 1
      i32.add
      local.set $moves
    end

    local.get $moves
    local.get $cells
    local.get $width
    local.get $tick
    local.get $seed
    local.get $block_x
    local.get $block_y
    local.get $top_left
    local.get $mask
    call $finish_block
    i32.add)

  (func $material_density (param $materials v128) (result v128)
    local.get $materials
    i32.const 2
    i32x4.splat
    i32x4.eq
    i32.const 2
    i32x4.splat
    v128.and
    local.get $materials
    i32.const 3
    i32x4.splat
    i32x4.eq
    i32.const 1
    i32x4.splat
    v128.and
    i32x4.add
    local.get $materials
    i32.const 4
    i32x4.splat
    i32x4.eq
    i32.const -1
    i32x4.splat
    v128.and
    i32x4.add)

  (func $should_fall_vector (param $top v128) (param $bottom v128) (result v128)
    (local $top_materials v128)
    (local $bottom_materials v128)
    local.get $top
    i32.const 255
    i32x4.splat
    v128.and
    local.set $top_materials
    local.get $bottom
    i32.const 255
    i32x4.splat
    v128.and
    local.set $bottom_materials
    local.get $top_materials
    i32.const 1
    i32x4.splat
    i32x4.ne
    local.get $bottom_materials
    i32.const 1
    i32x4.splat
    i32x4.ne
    v128.and
    local.get $top_materials
    call $material_density
    local.get $bottom_materials
    call $material_density
    i32x4.gt_s
    v128.and)

  (func $is_fluid_vector (param $cells v128) (result v128)
    (local $materials v128)
    local.get $cells
    i32.const 255
    i32x4.splat
    v128.and
    local.tee $materials
    i32.const 3
    i32x4.splat
    i32x4.eq
    local.get $materials
    i32.const 4
    i32x4.splat
    i32x4.eq
    v128.or)

  (func $flow_right_vector (param $left v128) (param $right v128) (result v128)
    local.get $left
    call $is_fluid_vector
    local.get $right
    i32.const 255
    i32x4.splat
    v128.and
    i32.const 0
    i32x4.splat
    i32x4.eq
    v128.and)

  (func $flow_left_vector (param $left v128) (param $right v128) (result v128)
    local.get $left
    i32.const 255
    i32x4.splat
    v128.and
    i32.const 0
    i32x4.splat
    i32x4.eq
    local.get $right
    call $is_fluid_vector
    v128.and)

  (func $block_random_vector
    (param $seed i32)
    (param $tick i32)
    (param $block_x v128)
    (param $block_y i32)
    (result v128)
    (local $value v128)
    local.get $seed
    i32x4.splat
    local.get $tick
    i32.const 1
    i32.add
    i32.const 0x9e3779b9
    i32.mul
    i32x4.splat
    v128.xor
    local.get $block_y
    i32.const 0x10001
    i32.mul
    i32.const 1
    i32.add
    i32x4.splat
    local.get $block_x
    i32x4.add
    i32.const 0x85ebca6b
    i32x4.splat
    i32x4.mul
    v128.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 13
    i32x4.shl
    v128.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 17
    i32x4.shr_u
    v128.xor
    local.set $value
    local.get $value
    local.get $value
    i32.const 5
    i32x4.shl
    v128.xor)

  (func $step_range (export "step_range")
    (param $cells i32)
    (param $width i32)
    (param $height i32)
    (param $tick i32)
    (param $seed i32)
    (param $left i32)
    (param $top i32)
    (param $right i32)
    (param $bottom i32)
    (result i64)
    (local $origin i32)
    (local $y i32)
    (local $x i32)
    (local $block_y i32)
    (local $block_x i32)
    (local $top_left i32)
    (local $bottom_left i32)
    (local $top_cells_0 v128)
    (local $top_cells_1 v128)
    (local $bottom_cells_0 v128)
    (local $bottom_cells_1 v128)
    (local $a v128)
    (local $b v128)
    (local $c v128)
    (local $d v128)
    (local $value v128)
    (local $moved v128)
    (local $random v128)
    (local $mask v128)
    (local $moves i32)
    (local $hot i32)

    local.get $tick
    i32.const 1
    i32.and
    local.set $origin
    local.get $top
    local.get $top
    local.get $origin
    i32.xor
    i32.const 1
    i32.and
    i32.add
    local.set $y
    block $rows_done
      loop $rows
        local.get $y
        local.get $bottom
        i32.ge_u
        br_if $rows_done
        local.get $y
        i32.const 1
        i32.add
        local.get $height
        i32.ge_u
        br_if $rows_done

        local.get $y
        local.get $origin
        i32.sub
        i32.const 1
        i32.shr_u
        local.set $block_y
        local.get $left
        local.get $left
        local.get $origin
        i32.xor
        i32.const 1
        i32.and
        i32.add
        local.set $x
        block $vectors_done
          loop $vectors
            local.get $x
            i32.const 6
            i32.add
            local.get $right
            i32.ge_u
            br_if $vectors_done
            local.get $x
            i32.const 7
            i32.add
            local.get $width
            i32.ge_u
            br_if $vectors_done

            local.get $cells
            local.get $y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            i32.const 2
            i32.shl
            i32.add
            local.tee $top_left
            v128.load
            local.set $top_cells_0
            local.get $top_left
            i32.const 16
            i32.add
            v128.load
            local.set $top_cells_1

            local.get $top_left
            local.get $width
            i32.const 2
            i32.shl
            i32.add
            local.tee $bottom_left
            v128.load
            local.set $bottom_cells_0
            local.get $bottom_left
            i32.const 16
            i32.add
            v128.load
            local.set $bottom_cells_1

            local.get $top_cells_0
            local.get $top_cells_1
            i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27
            local.set $a
            local.get $top_cells_0
            local.get $top_cells_1
            i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31
            local.set $b
            local.get $bottom_cells_0
            local.get $bottom_cells_1
            i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27
            local.set $c
            local.get $bottom_cells_0
            local.get $bottom_cells_1
            i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31
            local.set $d
            local.get $a
            local.get $b
            v128.or
            local.get $c
            v128.or
            local.get $d
            v128.or
            i32.const 254
            i32x4.splat
            v128.and
            v128.any_true
            if
              i32.const 1
              local.set $hot
            end
            v128.const i32x4 0 0 0 0
            local.set $moved

            local.get $a
            local.get $c
            call $should_fall_vector
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $c
            local.get $a
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $a
            local.get $c
            local.get $mask
            v128.bitselect
            local.set $c
            local.get $value
            local.set $a
            local.get $moved
            local.get $mask
            i32.const 5
            i32x4.splat
            v128.and
            v128.or
            local.set $moved

            local.get $b
            local.get $d
            call $should_fall_vector
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $d
            local.get $b
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $b
            local.get $d
            local.get $mask
            v128.bitselect
            local.set $d
            local.get $value
            local.set $b
            local.get $moved
            local.get $mask
            i32.const 10
            i32x4.splat
            v128.and
            v128.or
            local.set $moved

            local.get $x
            local.get $origin
            i32.sub
            i32.const 1
            i32.shr_u
            local.set $block_x
            local.get $seed
            local.get $tick
            local.get $block_x
            i32x4.splat
            v128.const i32x4 0 1 2 3
            i32x4.add
            local.get $block_y
            call $block_random_vector
            local.set $random

            local.get $random
            i32.const 3
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.ne
            local.get $moved
            i32.const 9
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.and
            local.get $a
            local.get $d
            call $should_fall_vector
            v128.and
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $d
            local.get $a
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $a
            local.get $d
            local.get $mask
            v128.bitselect
            local.set $d
            local.get $value
            local.set $a
            local.get $moved
            local.get $mask
            i32.const 9
            i32x4.splat
            v128.and
            v128.or
            local.set $moved

            local.get $random
            i32.const 2
            i32x4.shr_u
            i32.const 3
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.ne
            local.get $moved
            i32.const 6
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.and
            local.get $b
            local.get $c
            call $should_fall_vector
            v128.and
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $c
            local.get $b
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $b
            local.get $c
            local.get $mask
            v128.bitselect
            local.set $c
            local.get $value
            local.set $b
            local.get $moved
            local.get $mask
            i32.const 6
            i32x4.splat
            v128.and
            v128.or
            local.set $moved

            local.get $a
            local.get $b
            call $flow_right_vector
            local.get $a
            local.get $b
            call $flow_left_vector
            local.get $random
            i32.const 16
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.bitselect
            local.get $moved
            i32.const 3
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.and
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $b
            local.get $a
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $a
            local.get $b
            local.get $mask
            v128.bitselect
            local.set $b
            local.get $value
            local.set $a
            local.get $moved
            local.get $mask
            i32.const 3
            i32x4.splat
            v128.and
            v128.or
            local.set $moved

            local.get $c
            local.get $d
            call $flow_right_vector
            local.get $c
            local.get $d
            call $flow_left_vector
            local.get $random
            i32.const 32
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.bitselect
            local.get $moved
            i32.const 12
            i32x4.splat
            v128.and
            i32.const 0
            i32x4.splat
            i32x4.eq
            v128.and
            local.tee $mask
            i32x4.bitmask
            i32.popcnt
            local.get $moves
            i32.add
            local.set $moves
            local.get $d
            local.get $c
            local.get $mask
            v128.bitselect
            local.set $value
            local.get $c
            local.get $d
            local.get $mask
            v128.bitselect
            local.set $d
            local.get $value
            local.set $c

            local.get $top_left
            local.get $a
            local.get $b
            i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23
            v128.store
            local.get $top_left
            i32.const 16
            i32.add
            local.get $a
            local.get $b
            i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31
            v128.store
            local.get $bottom_left
            local.get $c
            local.get $d
            i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23
            v128.store
            local.get $bottom_left
            i32.const 16
            i32.add
            local.get $c
            local.get $d
            i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31
            v128.store

            local.get $x
            i32.const 8
            i32.add
            local.set $x
            br $vectors
          end
        end

        block $tail_done
          loop $tail
            local.get $x
            local.get $right
            i32.ge_u
            br_if $tail_done
            local.get $x
            i32.const 1
            i32.add
            local.get $width
            i32.ge_u
            br_if $tail_done
            local.get $x
            local.get $origin
            i32.sub
            i32.const 1
            i32.shr_u
            local.set $block_x
            local.get $cells
            local.get $y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            i32.const 2
            i32.shl
            i32.add
            local.tee $top_left
            i32.load
            local.get $top_left
            i32.const 4
            i32.add
            i32.load
            i32.or
            local.get $top_left
            local.get $width
            i32.const 2
            i32.shl
            i32.add
            local.tee $bottom_left
            i32.load
            i32.or
            local.get $bottom_left
            i32.const 4
            i32.add
            i32.load
            i32.or
            i32.const 254
            i32.and
            if
              i32.const 1
              local.set $hot
            end
            local.get $moves
            local.get $cells
            local.get $width
            local.get $tick
            local.get $seed
            local.get $block_x
            local.get $block_y
            local.get $top_left
            call $step_scalar_block
            i32.add
            local.set $moves
            local.get $x
            i32.const 2
            i32.add
            local.set $x
            br $tail
          end
        end

        local.get $y
        i32.const 2
        i32.add
        local.set $y
        br $rows
      end
    end
    local.get $hot
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $moves
    i64.extend_i32_u
    i64.or)

  (func (export "step")
    (param $cells i32)
    (param $width i32)
    (param $height i32)
    (param $tick i32)
    (param $seed i32)
    (result i32)
    local.get $cells
    local.get $width
    local.get $height
    local.get $tick
    local.get $seed
    i32.const 0
    i32.const 0
    local.get $width
    local.get $height
    call $step_range
    i32.wrap_i64))
