(module
  (memory (export "memory") 1)
  (func (export "find_byte") (param $ptr i32) (param $len i32)
    (param $needle i32) (result i32)
    (local $i i32) (local $mask i32) (local $end16 i32)
    local.get $len i32.const -16 i32.and local.set $end16
    block $vector_done
      loop $vector
        local.get $i local.get $end16 i32.ge_u br_if $vector_done
        local.get $ptr local.get $i i32.add v128.load
        local.get $needle i8x16.splat i8x16.eq i8x16.bitmask
        local.tee $mask
        if
          local.get $i local.get $mask i32.ctz i32.add return
        end
        local.get $i i32.const 16 i32.add local.set $i br $vector
      end
    end
    block $not_found
      loop $tail
        local.get $i local.get $len i32.ge_u br_if $not_found
        local.get $ptr local.get $i i32.add i32.load8_u
        local.get $needle i32.eq
        if local.get $i return end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    i32.const -1
  )

  (func (export "reverse_find_byte") (param $ptr i32) (param $len i32)
    (param $needle i32) (result i32)
    (local $i i32) (local $mask i32)
    local.get $len local.set $i
    block $tail_done
      loop $tail
        local.get $i i32.const 15 i32.le_u br_if $tail_done
        local.get $i i32.const 1 i32.sub local.tee $i
        local.get $ptr i32.add i32.load8_u
        local.get $needle i32.eq
        if local.get $i return end
        local.get $i i32.const 16 i32.rem_u i32.eqz br_if $tail_done
        br $tail
      end
    end
    block $not_found
      loop $vector
        local.get $i i32.eqz br_if $not_found
        local.get $i i32.const 16 i32.sub local.tee $i
        local.get $ptr i32.add v128.load
        local.get $needle i8x16.splat i8x16.eq i8x16.bitmask
        local.tee $mask
        if
          local.get $i i32.const 31 local.get $mask i32.clz i32.sub i32.add return
        end
        br $vector
      end
    end
    i32.const -1
  )

  (func (export "find_non_ascii") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32) (local $mask i32) (local $end16 i32)
    local.get $len i32.const -16 i32.and local.set $end16
    block $vector_done
      loop $vector
        local.get $i local.get $end16 i32.ge_u br_if $vector_done
        local.get $ptr local.get $i i32.add v128.load i8x16.bitmask
        local.tee $mask
        if local.get $i local.get $mask i32.ctz i32.add return end
        local.get $i i32.const 16 i32.add local.set $i br $vector
      end
    end
    block $not_found
      loop $tail
        local.get $i local.get $len i32.ge_u br_if $not_found
        local.get $ptr local.get $i i32.add i32.load8_u i32.const 128 i32.ge_u
        if local.get $i return end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    i32.const -1
  )

  (func (export "bytes_equal") (param $left i32) (param $right i32)
    (param $len i32) (result i32)
    (local $i i32) (local $end16 i32)
    local.get $len i32.const -16 i32.and local.set $end16
    block $vector_done
      loop $vector
        local.get $i local.get $end16 i32.ge_u br_if $vector_done
        local.get $left local.get $i i32.add v128.load
        local.get $right local.get $i i32.add v128.load
        v128.xor v128.any_true
        if i32.const 0 return end
        local.get $i i32.const 16 i32.add local.set $i br $vector
      end
    end
    block $equal
      loop $tail
        local.get $i local.get $len i32.ge_u br_if $equal
        local.get $left local.get $i i32.add i32.load8_u
        local.get $right local.get $i i32.add i32.load8_u i32.ne
        if i32.const 0 return end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    i32.const 1
  )

  ;; Return the first differing byte delta, or zero for an equal prefix.
  (func (export "lexical_compare_prefix") (param $left i32) (param $right i32)
    (param $len i32) (result i32)
    (local $i i32) (local $mask i32) (local $end16 i32)
    local.get $len i32.const -16 i32.and local.set $end16
    block $vector_done
      loop $vector
        local.get $i local.get $end16 i32.ge_u br_if $vector_done
        local.get $left local.get $i i32.add v128.load
        local.get $right local.get $i i32.add v128.load
        i8x16.eq i8x16.bitmask i32.const 65535 i32.xor
        local.tee $mask
        if
          local.get $i local.get $mask i32.ctz i32.add local.set $i
          local.get $left local.get $i i32.add i32.load8_u
          local.get $right local.get $i i32.add i32.load8_u i32.sub return
        end
        local.get $i i32.const 16 i32.add local.set $i br $vector
      end
    end
    block $equal
      loop $tail
        local.get $i local.get $len i32.ge_u br_if $equal
        local.get $left local.get $i i32.add i32.load8_u
        local.get $right local.get $i i32.add i32.load8_u i32.sub
        local.tee $mask
        if local.get $mask return end
        local.get $i i32.const 1 i32.add local.set $i br $tail
      end
    end
    i32.const 0
  )

  ;; First/last-byte SIMD prefilter plus in-Wasm full candidate verification.
  (func (export "index_of_subarray") (param $haystack i32) (param $haystack_len i32)
    (param $needle i32) (param $needle_len i32) (result i32)
    (local $candidate i32) (local $limit i32) (local $last i32)
    (local $mask i32) (local $j i32)
    local.get $needle_len i32.eqz if i32.const 0 return end
    local.get $needle_len local.get $haystack_len i32.gt_u
    if i32.const -1 return end
    local.get $needle_len i32.const 1 i32.sub local.set $last
    local.get $haystack_len local.get $needle_len i32.sub i32.const 1 i32.add local.set $limit
    block $not_found
      loop $search
        local.get $candidate local.get $limit i32.ge_u br_if $not_found
        local.get $candidate i32.const 16 i32.add local.get $limit i32.le_u
        if
          local.get $haystack local.get $candidate i32.add v128.load
          local.get $needle i32.load8_u i8x16.splat i8x16.eq
          local.get $haystack local.get $candidate i32.add local.get $last i32.add v128.load
          local.get $needle local.get $last i32.add i32.load8_u i8x16.splat i8x16.eq
          v128.and i8x16.bitmask local.tee $mask
          i32.eqz
          if
            local.get $candidate i32.const 16 i32.add local.set $candidate br $search
          end
          local.get $candidate local.get $mask i32.ctz i32.add local.set $candidate
        else
          local.get $haystack local.get $candidate i32.add i32.load8_u
          local.get $needle i32.load8_u i32.ne
          local.get $haystack local.get $candidate i32.add local.get $last i32.add i32.load8_u
          local.get $needle local.get $last i32.add i32.load8_u i32.ne i32.or
          if
            local.get $candidate i32.const 1 i32.add local.set $candidate br $search
          end
        end
        i32.const 1 local.set $j
        block $failed
          loop $verify
            local.get $j local.get $last i32.ge_u
            if local.get $candidate return end
            local.get $haystack local.get $candidate i32.add local.get $j i32.add i32.load8_u
            local.get $needle local.get $j i32.add i32.load8_u i32.ne br_if $failed
            local.get $j i32.const 1 i32.add local.set $j br $verify
          end
        end
        local.get $candidate i32.const 1 i32.add local.set $candidate br $search
      end
    end
    i32.const -1
  )


)
