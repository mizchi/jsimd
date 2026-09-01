(module
  (import "jsimd" "memory" (memory 1))

  ;; Union subscriber bitmap rows selected by a list of signal IDs. Rows and output are padded to
  ;; four u32 words, so every loop iteration is one 128-bit vector with no scalar tail.
  (func (export "union_subscriber_rows")
    (param $matrix i32)
    (param $signal_ids i32)
    (param $signal_count i32)
    (param $padded_words i32)
    (param $output i32)
    (local $word i32)
    (local $signal_index i32)
    (local $signal_id i32)
    (local $acc v128)
    block $done
      loop $words
        local.get $word
        local.get $padded_words
        i32.ge_u
        br_if $done

        v128.const i32x4 0 0 0 0
        local.set $acc
        i32.const 0
        local.set $signal_index
        block $signals_done
          loop $signals
            local.get $signal_index
            local.get $signal_count
            i32.ge_u
            br_if $signals_done

            local.get $signal_ids
            local.get $signal_index
            i32.const 2
            i32.shl
            i32.add
            i32.load
            local.set $signal_id

            local.get $acc
            local.get $matrix
            local.get $signal_id
            local.get $padded_words
            i32.mul
            local.get $word
            i32.add
            i32.const 2
            i32.shl
            i32.add
            v128.load
            v128.or
            local.set $acc

            local.get $signal_index
            i32.const 1
            i32.add
            local.set $signal_index
            br $signals
          end
        end

        local.get $output
        local.get $word
        i32.const 2
        i32.shl
        i32.add
        local.get $acc
        v128.store

        local.get $word
        i32.const 4
        i32.add
        local.set $word
        br $words
      end
    end))
