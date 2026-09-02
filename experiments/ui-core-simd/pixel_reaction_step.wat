(module
  (import "jsimd" "memory" (memory 1))

  (func $temperature (param $cell i32) (result i32)
    local.get $cell
    i32.const 8
    i32.shr_u
    i32.const 255
    i32.and)

  (func $chemistry_property_scalar (param $material i32) (result i32)
    local.get $material
    i32.const 16
    i32.lt_u
    if (result i32)
      i64.const 0xa40000201000
      local.get $material
      i64.extend_i32_u
      i64.const 2
      i64.shl
      i64.shr_u
      i32.wrap_i64
      i32.const 15
      i32.and
    else
      i32.const 0
    end)

  (func $event_kind (param $cell i32) (result i32)
    i64.const 0x6004312005
    local.get $cell
    i32.const 255
    i32.and
    i64.extend_i32_u
    i64.const 2
    i64.shl
    i64.shr_u
    i32.wrap_i64
    i32.const 15
    i32.and)

  (func $react_scalar
    (param $cells i32)
    (param $width i32)
    (param $height i32)
    (param $x i32)
    (param $y i32)
    (result i32)
    (local $index i32)
    (local $left i32)
    (local $right i32)
    (local $top i32)
    (local $bottom i32)
    (local $cell i32)
    (local $material i32)
    (local $temperature i32)
    (local $neighbor_flags i32)

    local.get $y
    local.get $width
    i32.mul
    local.get $x
    i32.add
    local.tee $index
    i32.const 2
    i32.shl
    local.get $cells
    i32.add
    i32.load
    local.tee $cell
    i32.const 255
    i32.and
    local.set $material

    local.get $x
    i32.eqz
    if (result i32)
      local.get $index
    else
      local.get $index
      i32.const 1
      i32.sub
    end
    local.set $left
    local.get $x
    i32.const 1
    i32.add
    local.get $width
    i32.eq
    if (result i32)
      local.get $index
    else
      local.get $index
      i32.const 1
      i32.add
    end
    local.set $right
    local.get $y
    i32.eqz
    if (result i32)
      local.get $index
    else
      local.get $index
      local.get $width
      i32.sub
    end
    local.set $top
    local.get $y
    i32.const 1
    i32.add
    local.get $height
    i32.eq
    if (result i32)
      local.get $index
    else
      local.get $index
      local.get $width
      i32.add
    end
    local.set $bottom

    local.get $cells
    local.get $left
    i32.const 2
    i32.shl
    i32.add
    i32.load
    i32.const 255
    i32.and
    call $chemistry_property_scalar
    local.get $cells
    local.get $right
    i32.const 2
    i32.shl
    i32.add
    i32.load
    i32.const 255
    i32.and
    call $chemistry_property_scalar
    i32.or
    local.get $cells
    local.get $top
    i32.const 2
    i32.shl
    i32.add
    i32.load
    i32.const 255
    i32.and
    call $chemistry_property_scalar
    i32.or
    local.get $cells
    local.get $bottom
    i32.const 2
    i32.shl
    i32.add
    i32.load
    i32.const 255
    i32.and
    call $chemistry_property_scalar
    i32.or
    local.set $neighbor_flags

    local.get $material
    i32.const 5
    i32.eq
    local.get $material
    i32.const 11
    i32.eq
    i32.or
    if
      i32.const 255
      local.set $temperature
    else
      local.get $cell
      call $temperature
      i32.const 2
      i32.shl
      local.get $cells
      local.get $left
      i32.const 2
      i32.shl
      i32.add
      i32.load
      call $temperature
      i32.add
      local.get $cells
      local.get $right
      i32.const 2
      i32.shl
      i32.add
      i32.load
      call $temperature
      i32.add
      local.get $cells
      local.get $top
      i32.const 2
      i32.shl
      i32.add
      i32.load
      call $temperature
      i32.add
      local.get $cells
      local.get $bottom
      i32.const 2
      i32.shl
      i32.add
      i32.load
      call $temperature
      i32.add
      i32.const 3
      i32.shr_u
      local.set $temperature
    end

    local.get $material
    i32.const 3
    i32.eq
    local.get $neighbor_flags
    i32.const 8
    i32.and
    i32.const 0
    i32.ne
    i32.and
    local.get $material
    i32.const 11
    i32.eq
    local.get $neighbor_flags
    i32.const 1
    i32.and
    i32.const 0
    i32.ne
    i32.and
    i32.or
    if
      i32.const 6
      local.set $material
    else
      local.get $material
      i32.const 5
      i32.eq
      local.get $neighbor_flags
      i32.const 1
      i32.and
      i32.const 0
      i32.ne
      i32.and
      if
        i32.const 9
        local.set $material
      else
      local.get $material
      i32.const 6
      i32.eq
      local.get $material
      i32.const 7
      i32.eq
      i32.or
      local.get $neighbor_flags
      i32.const 4
      i32.and
      i32.const 0
      i32.ne
      i32.and
      if
        i32.const 0
        local.set $material
      else
        local.get $material
        i32.const 3
        i32.eq
        local.get $temperature
        i32.const 140
        i32.ge_u
        i32.and
        if
          i32.const 4
          local.set $material
        else
          local.get $material
          i32.const 4
          i32.eq
          local.get $temperature
          i32.const 112
          i32.le_u
          i32.and
          if
            i32.const 3
            local.set $material
          else
            local.get $material
            i32.const 7
            i32.eq
            local.get $material
            i32.const 8
            i32.eq
            i32.or
            local.get $temperature
            i32.const 180
            i32.ge_u
            local.get $neighbor_flags
            i32.const 2
            i32.and
            i32.const 0
            i32.ne
            i32.or
            i32.and
            if
              i32.const 5
              local.set $material
            end
          end
        end
      end
      end
    end

    local.get $cell
    i32.const 0xffff0000
    i32.and
    local.get $temperature
    i32.const 8
    i32.shl
    i32.or
    local.get $material
    i32.or)

  ;; Returns reactions in the low word and dropped events in the high word.
  (func $emit
    (param $events i32)
    (param $capacity i32)
    (param $index i32)
    (param $before i32)
    (param $after i32)
    (param $reactions i32)
    (param $dropped i32)
    (result i64)
    (local $offset i32)
    local.get $reactions
    local.get $capacity
    i32.lt_u
    if
      local.get $events
      local.get $reactions
      i32.const 4
      i32.shl
      i32.add
      local.tee $offset
      local.get $after
      call $event_kind
      i32.store
      local.get $offset
      i32.const 4
      i32.add
      local.get $index
      i32.store
      local.get $offset
      i32.const 8
      i32.add
      local.get $before
      i32.store
      local.get $offset
      i32.const 12
      i32.add
      local.get $after
      i32.store
    else
      local.get $dropped
      i32.const 1
      i32.add
      local.set $dropped
    end
    local.get $dropped
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $reactions
    i32.const 1
    i32.add
    i64.extend_i32_u
    i64.or)

  (func (export "step")
    (param $cells i32)
    (param $scratch i32)
    (param $width i32)
    (param $height i32)
    (param $events i32)
    (param $capacity i32)
    (result i64)
    (local $x i32)
    (local $y i32)
    (local $index i32)
    (local $top_y i32)
    (local $bottom_y i32)
    (local $before i32)
    (local $after i32)
    (local $cell v128)
    (local $material v128)
    (local $temperature v128)
    (local $next_material v128)
    (local $left_cells v128)
    (local $right_cells v128)
    (local $top_cells v128)
    (local $bottom_cells v128)
    (local $neighbor_flags v128)
    (local $boil v128)
    (local $condense v128)
    (local $fire v128)
    (local $ignite v128)
    (local $solidify v128)
    (local $corrode v128)
    (local $extinguish v128)
    (local $after4 v128)
    (local $changed i32)
    (local $lane i32)
    (local $reactions i32)
    (local $dropped i32)
    (local $packed i64)

    i32.const 0
    local.set $y
    block $rows_done
      loop $rows
        local.get $y
        local.get $height
        i32.ge_u
        br_if $rows_done

        local.get $y
        i32.eqz
        if (result i32)
          local.get $y
        else
          local.get $y
          i32.const 1
          i32.sub
        end
        local.set $top_y
        local.get $y
        i32.const 1
        i32.add
        local.get $height
        i32.eq
        if (result i32)
          local.get $y
        else
          local.get $y
          i32.const 1
          i32.add
        end
        local.set $bottom_y

        i32.const 0
        local.set $x
        block $prefix_done
          loop $scalar_prefix
            local.get $x
            i32.const 1
            i32.ge_u
            br_if $prefix_done
            local.get $x
            local.get $width
            i32.ge_u
            br_if $prefix_done
          local.get $y
          local.get $width
          i32.mul
          local.get $x
          i32.add
          local.tee $index
          i32.const 2
          i32.shl
          local.get $cells
          i32.add
          i32.load
          local.set $before
          local.get $cells
          local.get $width
          local.get $height
          local.get $x
          local.get $y
          call $react_scalar
          local.set $after
          local.get $scratch
          local.get $index
          i32.const 2
          i32.shl
          i32.add
          local.get $after
          i32.store
          local.get $before
          i32.const 255
          i32.and
          local.get $after
          i32.const 255
          i32.and
          i32.ne
          if
            local.get $events
            local.get $capacity
            local.get $index
            local.get $before
            local.get $after
            local.get $reactions
            local.get $dropped
            call $emit
            local.tee $packed
            i32.wrap_i64
            local.set $reactions
            local.get $packed
            i64.const 32
            i64.shr_u
            i32.wrap_i64
            local.set $dropped
          end
            local.get $x
            i32.const 1
            i32.add
            local.set $x
            br $scalar_prefix
          end
        end

        block $vectors_done
          loop $vectors
            local.get $x
            i32.const 3
            i32.add
            local.get $width
            i32.const 1
            i32.sub
            i32.ge_u
            br_if $vectors_done

            local.get $y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            local.set $index
            local.get $cells
            local.get $index
            i32.const 2
            i32.shl
            i32.add
            v128.load
            local.set $cell
            local.get $cell
            v128.const i32x4 255 255 255 255
            v128.and
            local.tee $material
            v128.const i32x4 5 5 5 5
            i32x4.eq
            local.get $material
            v128.const i32x4 11 11 11 11
            i32x4.eq
            v128.or
            local.set $fire

            local.get $cell
            i32.const 8
            i32x4.shr_u
            v128.const i32x4 255 255 255 255
            v128.and
            i32.const 2
            i32x4.shl
            local.get $cells
            local.get $index
            i32.const 1
            i32.sub
            i32.const 2
            i32.shl
            i32.add
            v128.load
            local.tee $left_cells
            i32.const 8
            i32x4.shr_u
            v128.const i32x4 255 255 255 255
            v128.and
            i32x4.add
            local.get $cells
            local.get $index
            i32.const 1
            i32.add
            i32.const 2
            i32.shl
            i32.add
            v128.load
            local.tee $right_cells
            i32.const 8
            i32x4.shr_u
            v128.const i32x4 255 255 255 255
            v128.and
            i32x4.add
            local.get $cells
            local.get $top_y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            i32.const 2
            i32.shl
            i32.add
            v128.load
            local.tee $top_cells
            i32.const 8
            i32x4.shr_u
            v128.const i32x4 255 255 255 255
            v128.and
            i32x4.add
            local.get $cells
            local.get $bottom_y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            i32.const 2
            i32.shl
            i32.add
            v128.load
            local.tee $bottom_cells
            i32.const 8
            i32x4.shr_u
            v128.const i32x4 255 255 255 255
            v128.and
            i32x4.add
            i32.const 3
            i32x4.shr_u
            local.set $temperature

            v128.const i8x16 0 0 0 1 0 2 0 0 0 0 4 10 0 0 0 0
            local.get $left_cells
            local.get $right_cells
            i8x16.shuffle 0 16 4 20 8 24 12 28 0 0 0 0 0 0 0 0
            local.get $top_cells
            local.get $bottom_cells
            i8x16.shuffle 0 16 4 20 8 24 12 28 0 0 0 0 0 0 0 0
            i8x16.shuffle 0 1 16 17 2 3 18 19 4 5 20 21 6 7 22 23
            i8x16.swizzle
            local.tee $neighbor_flags
            local.get $neighbor_flags
            i32.const 8
            i32x4.shr_u
            v128.or
            local.tee $neighbor_flags
            local.get $neighbor_flags
            i32.const 16
            i32x4.shr_u
            v128.or
            v128.const i32x4 255 255 255 255
            v128.and
            local.set $neighbor_flags

            v128.const i32x4 255 255 255 255
            local.get $temperature
            local.get $fire
            v128.bitselect
            local.set $temperature
            local.get $material
            v128.const i32x4 3 3 3 3
            i32x4.eq
            local.get $temperature
            v128.const i32x4 140 140 140 140
            i32x4.ge_u
            v128.and
            local.set $boil
            local.get $material
            v128.const i32x4 4 4 4 4
            i32x4.eq
            local.get $temperature
            v128.const i32x4 112 112 112 112
            i32x4.le_u
            v128.and
            local.set $condense
            local.get $material
            v128.const i32x4 7 7 7 7
            i32x4.eq
            local.get $material
            v128.const i32x4 8 8 8 8
            i32x4.eq
            v128.or
            local.get $temperature
            v128.const i32x4 180 180 180 180
            i32x4.ge_u
            local.get $neighbor_flags
            v128.const i32x4 2 2 2 2
            v128.and
            v128.const i32x4 0 0 0 0
            i32x4.ne
            v128.or
            v128.and
            local.set $ignite
            local.get $material
            v128.const i32x4 3 3 3 3
            i32x4.eq
            local.get $neighbor_flags
            v128.const i32x4 8 8 8 8
            v128.and
            v128.const i32x4 0 0 0 0
            i32x4.ne
            v128.and
            local.get $material
            v128.const i32x4 11 11 11 11
            i32x4.eq
            local.get $neighbor_flags
            v128.const i32x4 1 1 1 1
            v128.and
            v128.const i32x4 0 0 0 0
            i32x4.ne
            v128.and
            v128.or
            local.set $solidify
            local.get $material
            v128.const i32x4 6 6 6 6
            i32x4.eq
            local.get $material
            v128.const i32x4 7 7 7 7
            i32x4.eq
            v128.or
            local.get $neighbor_flags
            v128.const i32x4 4 4 4 4
            v128.and
            v128.const i32x4 0 0 0 0
            i32x4.ne
            v128.and
            local.set $corrode
            local.get $material
            v128.const i32x4 5 5 5 5
            i32x4.eq
            local.get $neighbor_flags
            v128.const i32x4 1 1 1 1
            v128.and
            v128.const i32x4 0 0 0 0
            i32x4.ne
            v128.and
            local.set $extinguish
            v128.const i32x4 4 4 4 4
            local.get $material
            local.get $boil
            v128.bitselect
            local.set $next_material
            v128.const i32x4 3 3 3 3
            local.get $next_material
            local.get $condense
            v128.bitselect
            local.set $next_material
            v128.const i32x4 5 5 5 5
            local.get $next_material
            local.get $ignite
            v128.bitselect
            local.set $next_material
            v128.const i32x4 9 9 9 9
            local.get $next_material
            local.get $extinguish
            v128.bitselect
            local.set $next_material
            v128.const i32x4 0 0 0 0
            local.get $next_material
            local.get $corrode
            v128.bitselect
            local.set $next_material
            v128.const i32x4 6 6 6 6
            local.get $next_material
            local.get $solidify
            v128.bitselect
            local.set $next_material

            local.get $cell
            v128.const i32x4 0xffff0000 0xffff0000 0xffff0000 0xffff0000
            v128.and
            local.get $temperature
            i32.const 8
            i32x4.shl
            v128.or
            local.get $next_material
            v128.or
            local.set $after4
            local.get $scratch
            local.get $index
            i32.const 2
            i32.shl
            i32.add
            local.get $after4
            v128.store

            local.get $material
            local.get $next_material
            i32x4.ne
            i32x4.bitmask
            local.set $changed
            i32.const 0
            local.set $lane
            block $lanes_done
              loop $lanes
                local.get $lane
                i32.const 4
                i32.ge_u
                br_if $lanes_done
                local.get $changed
                i32.const 1
                local.get $lane
                i32.shl
                i32.and
                if
                  local.get $cells
                  local.get $index
                  local.get $lane
                  i32.add
                  i32.const 2
                  i32.shl
                  i32.add
                  i32.load
                  local.set $before
                  local.get $scratch
                  local.get $index
                  local.get $lane
                  i32.add
                  i32.const 2
                  i32.shl
                  i32.add
                  i32.load
                  local.set $after
                  local.get $events
                  local.get $capacity
                  local.get $index
                  local.get $lane
                  i32.add
                  local.get $before
                  local.get $after
                  local.get $reactions
                  local.get $dropped
                  call $emit
                  local.tee $packed
                  i32.wrap_i64
                  local.set $reactions
                  local.get $packed
                  i64.const 32
                  i64.shr_u
                  i32.wrap_i64
                  local.set $dropped
                end
                local.get $lane
                i32.const 1
                i32.add
                local.set $lane
                br $lanes
              end
            end
            local.get $x
            i32.const 4
            i32.add
            local.set $x
            br $vectors
          end
        end

        block $tails_done
          loop $tails
            local.get $x
            local.get $width
            i32.ge_u
            br_if $tails_done
            local.get $y
            local.get $width
            i32.mul
            local.get $x
            i32.add
            local.tee $index
            i32.const 2
            i32.shl
            local.get $cells
            i32.add
            i32.load
            local.set $before
            local.get $cells
            local.get $width
            local.get $height
            local.get $x
            local.get $y
            call $react_scalar
            local.set $after
            local.get $scratch
            local.get $index
            i32.const 2
            i32.shl
            i32.add
            local.get $after
            i32.store
            local.get $before
            i32.const 255
            i32.and
            local.get $after
            i32.const 255
            i32.and
            i32.ne
            if
              local.get $events
              local.get $capacity
              local.get $index
              local.get $before
              local.get $after
              local.get $reactions
              local.get $dropped
              call $emit
              local.tee $packed
              i32.wrap_i64
              local.set $reactions
              local.get $packed
              i64.const 32
              i64.shr_u
              i32.wrap_i64
              local.set $dropped
            end
            local.get $x
            i32.const 1
            i32.add
            local.set $x
            br $tails
          end
        end

        local.get $y
        i32.const 1
        i32.add
        local.set $y
        br $rows
      end
    end

    local.get $cells
    local.get $scratch
    local.get $width
    local.get $height
    i32.mul
    i32.const 2
    i32.shl
    memory.copy

    local.get $dropped
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $reactions
    i64.extend_i32_u
    i64.or)
)
