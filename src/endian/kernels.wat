(module
  (memory (export "memory") 1)
  ;; Reverse bytes within each 32-bit word. The byte length must be a multiple of four.
  (func (export "byte_swap32") (param $ptr i32) (param $len i32)
    (local $i i32) (local $end16 i32) (local $chunk v128) (local $word i32)
    local.get $len i32.const -16 i32.and local.set $end16
    block $vector_done
      loop $vector
        local.get $i local.get $end16 i32.ge_u br_if $vector_done
        local.get $ptr local.get $i i32.add v128.load local.set $chunk
        local.get $ptr local.get $i i32.add
        local.get $chunk local.get $chunk
        i8x16.shuffle 3 2 1 0 7 6 5 4 11 10 9 8 15 14 13 12
        v128.store
        local.get $i i32.const 16 i32.add local.set $i br $vector
      end
    end
    block $done
      loop $tail
        local.get $i local.get $len i32.ge_u br_if $done
        local.get $ptr local.get $i i32.add i32.load local.set $word
        local.get $ptr local.get $i i32.add
        local.get $word i32.const 24 i32.shl
        local.get $word i32.const 65280 i32.and i32.const 8 i32.shl i32.or
        local.get $word i32.const 16711680 i32.and i32.const 8 i32.shr_u i32.or
        local.get $word i32.const 24 i32.shr_u i32.or
        i32.store
        local.get $i i32.const 4 i32.add local.set $i br $tail
      end
    end
  )
)
