(module
  (import "jsimd" "memory" (memory 1))

  ;; Scalar edge/tail cell. The SIMD loop handles the contiguous interior without row halos.
  (func $scalar_cell
    (param $current i32)
    (param $next i32)
    (param $width i32)
    (param $height i32)
    (param $row i32)
    (param $x i32)
    (result i32)
    (local $up i32)
    (local $middle i32)
    (local $down i32)
    (local $left i32)
    (local $right i32)
    (local $index i32)
    (local $neighbors i32)
    (local $alive i32)

    local.get $current
    local.get $row
    i32.eqz
    if (result i32)
      local.get $height
      i32.const 1
      i32.sub
    else
      local.get $row
      i32.const 1
      i32.sub
    end
    local.get $width
    i32.mul
    i32.add
    local.set $up

    local.get $current
    local.get $row
    local.get $width
    i32.mul
    i32.add
    local.set $middle

    local.get $current
    local.get $row
    i32.const 1
    i32.add
    local.get $height
    i32.eq
    if (result i32)
      i32.const 0
    else
      local.get $row
      i32.const 1
      i32.add
    end
    local.get $width
    i32.mul
    i32.add
    local.set $down

    local.get $x
    i32.eqz
    if (result i32)
      local.get $width
      i32.const 1
      i32.sub
    else
      local.get $x
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
      i32.const 0
    else
      local.get $x
      i32.const 1
      i32.add
    end
    local.set $right

    local.get $middle
    local.get $x
    i32.add
    local.set $index

    local.get $up
    local.get $left
    i32.add
    i32.load8_u
    local.get $up
    local.get $x
    i32.add
    i32.load8_u
    i32.add
    local.get $up
    local.get $right
    i32.add
    i32.load8_u
    i32.add
    local.get $middle
    local.get $left
    i32.add
    i32.load8_u
    i32.add
    local.get $middle
    local.get $right
    i32.add
    i32.load8_u
    i32.add
    local.get $down
    local.get $left
    i32.add
    i32.load8_u
    i32.add
    local.get $down
    local.get $x
    i32.add
    i32.load8_u
    i32.add
    local.get $down
    local.get $right
    i32.add
    i32.load8_u
    i32.add
    local.set $neighbors

    local.get $neighbors
    i32.const 3
    i32.eq
    local.get $neighbors
    i32.const 2
    i32.eq
    local.get $index
    i32.load8_u
    i32.const 0
    i32.ne
    i32.and
    i32.or
    local.set $alive

    local.get $next
    local.get $row
    local.get $width
    i32.mul
    i32.add
    local.get $x
    i32.add
    local.get $alive
    i32.store8
    local.get $alive)

  ;; Process 16 adjacent cells per vector. x=0 and the final partial block use scalar_cell so
  ;; unaligned neighbor loads never cross a row boundary.
  (func (export "step")
    (param $current i32)
    (param $next i32)
    (param $width i32)
    (param $height i32)
    (result i32)
    (local $row i32)
    (local $x i32)
    (local $up i32)
    (local $middle i32)
    (local $down i32)
    (local $target i32)
    (local $sum v128)
    (local $current_cells v128)
    (local $alive_mask v128)
    (local $live i32)

    block $rows_done
      loop $rows
        local.get $row
        local.get $height
        i32.ge_u
        br_if $rows_done

        local.get $current
        local.get $row
        i32.eqz
        if (result i32)
          local.get $height
          i32.const 1
          i32.sub
        else
          local.get $row
          i32.const 1
          i32.sub
        end
        local.get $width
        i32.mul
        i32.add
        local.set $up

        local.get $current
        local.get $row
        local.get $width
        i32.mul
        i32.add
        local.set $middle

        local.get $current
        local.get $row
        i32.const 1
        i32.add
        local.get $height
        i32.eq
        if (result i32)
          i32.const 0
        else
          local.get $row
          i32.const 1
          i32.add
        end
        local.get $width
        i32.mul
        i32.add
        local.set $down

        local.get $next
        local.get $row
        local.get $width
        i32.mul
        i32.add
        local.set $target

        local.get $live
        local.get $current
        local.get $next
        local.get $width
        local.get $height
        local.get $row
        i32.const 0
        call $scalar_cell
        i32.add
        local.set $live

        i32.const 1
        local.set $x
        block $vectors_done
          loop $vectors
            local.get $x
            i32.const 15
            i32.add
            local.get $width
            i32.ge_u
            br_if $vectors_done

            local.get $up
            local.get $x
            i32.add
            i32.const 1
            i32.sub
            v128.load
            local.get $up
            local.get $x
            i32.add
            v128.load
            i8x16.add
            local.get $up
            local.get $x
            i32.add
            i32.const 1
            i32.add
            v128.load
            i8x16.add
            local.get $middle
            local.get $x
            i32.add
            i32.const 1
            i32.sub
            v128.load
            i8x16.add
            local.get $middle
            local.get $x
            i32.add
            i32.const 1
            i32.add
            v128.load
            i8x16.add
            local.get $down
            local.get $x
            i32.add
            i32.const 1
            i32.sub
            v128.load
            i8x16.add
            local.get $down
            local.get $x
            i32.add
            v128.load
            i8x16.add
            local.get $down
            local.get $x
            i32.add
            i32.const 1
            i32.add
            v128.load
            i8x16.add
            local.set $sum

            local.get $middle
            local.get $x
            i32.add
            v128.load
            local.set $current_cells

            local.get $sum
            i32.const 3
            i8x16.splat
            i8x16.eq
            local.get $sum
            i32.const 2
            i8x16.splat
            i8x16.eq
            local.get $current_cells
            i32.const 0
            i8x16.splat
            i8x16.ne
            v128.and
            v128.or
            local.set $alive_mask

            local.get $live
            local.get $alive_mask
            i8x16.bitmask
            i32.popcnt
            i32.add
            local.set $live

            local.get $target
            local.get $x
            i32.add
            local.get $alive_mask
            i32.const 1
            i8x16.splat
            v128.and
            v128.store

            local.get $x
            i32.const 16
            i32.add
            local.set $x
            br $vectors
          end
        end

        block $tail_done
          loop $tail
            local.get $x
            local.get $width
            i32.ge_u
            br_if $tail_done
            local.get $live
            local.get $current
            local.get $next
            local.get $width
            local.get $height
            local.get $row
            local.get $x
            call $scalar_cell
            i32.add
            local.set $live
            local.get $x
            i32.const 1
            i32.add
            local.set $x
            br $tail
          end
        end

        local.get $row
        i32.const 1
        i32.add
        local.set $row
        br $rows
      end
    end
    local.get $live))
