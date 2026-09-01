(module
  (import "jsimd" "memory" (memory 1))

  ;; Compare four numeric bindings at a time. Changed lanes are compacted into a pair of
  ;; binding-id/value arrays in ascending binding order. The scalar tail handles 0-3 bindings.
  (func (export "collect_changed")
    (param $current i32)
    (param $previous i32)
    (param $count i32)
    (param $output_ids i32)
    (param $output_values i32)
    (result i32)
    (local $index i32)
    (local $output_count i32)
    (local $lane i32)
    (local $mask i32)
    (local $current_vector v128)

    block $vectors_done
      loop $vectors
        local.get $index
        i32.const 4
        i32.add
        local.get $count
        i32.gt_u
        br_if $vectors_done

        local.get $current
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        v128.load
        local.tee $current_vector
        local.get $previous
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        v128.load
        i32x4.ne
        i32x4.bitmask
        local.set $mask

        local.get $previous
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        local.get $current_vector
        v128.store

        local.get $mask
        i32.const 15
        i32.eq
        if
          local.get $output_ids
          local.get $output_count
          i32.const 2
          i32.shl
          i32.add
          local.get $index
          i32x4.splat
          v128.const i32x4 0 1 2 3
          i32x4.add
          v128.store

          local.get $output_values
          local.get $output_count
          i32.const 2
          i32.shl
          i32.add
          local.get $current_vector
          v128.store

          local.get $output_count
          i32.const 4
          i32.add
          local.set $output_count
        else
          block $lanes_done
            loop $lanes
              local.get $mask
              i32.eqz
              br_if $lanes_done

              local.get $mask
              i32.ctz
              local.set $lane

              local.get $output_ids
              local.get $output_count
              i32.const 2
              i32.shl
              i32.add
              local.get $index
              local.get $lane
              i32.add
              i32.store

              local.get $output_values
              local.get $output_count
              i32.const 2
              i32.shl
              i32.add
              local.get $current
              local.get $index
              local.get $lane
              i32.add
              i32.const 2
              i32.shl
              i32.add
              i32.load
              i32.store

              local.get $output_count
              i32.const 1
              i32.add
              local.set $output_count

              local.get $mask
              local.get $mask
              i32.const 1
              i32.sub
              i32.and
              local.set $mask
              br $lanes
            end
          end
        end

        local.get $index
        i32.const 4
        i32.add
        local.set $index
        br $vectors
      end
    end

    block $tail_done
      loop $tail
        local.get $index
        local.get $count
        i32.ge_u
        br_if $tail_done

        local.get $current
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load
        local.get $previous
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load
        i32.ne
        if
          local.get $output_ids
          local.get $output_count
          i32.const 2
          i32.shl
          i32.add
          local.get $index
          i32.store

          local.get $output_values
          local.get $output_count
          i32.const 2
          i32.shl
          i32.add
          local.get $current
          local.get $index
          i32.const 2
          i32.shl
          i32.add
          i32.load
          i32.store

          local.get $previous
          local.get $index
          i32.const 2
          i32.shl
          i32.add
          local.get $current
          local.get $index
          i32.const 2
          i32.shl
          i32.add
          i32.load
          i32.store

          local.get $output_count
          i32.const 1
          i32.add
          local.set $output_count
        end

        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $tail
      end
    end

    local.get $output_count))
