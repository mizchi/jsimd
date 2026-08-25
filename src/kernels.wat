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

  ;; Classify 16 bytes at a time, then apply the JSON string/atom state machine
  ;; and write token-start byte offsets as little-endian u32 values.
  (func (export "json_token_starts") (param $input i32) (param $len i32)
    (param $output i32) (result i32)
    (local $base i32) (local $count i32) (local $lane i32) (local $bit i32)
    (local $quote i32) (local $backslash i32) (local $structural i32)
    (local $whitespace i32) (local $in_string i32) (local $escaped i32)
    (local $previous_atom i32) (local $output_count i32) (local $chunk v128)
    block $done
      loop $blocks
        local.get $base local.get $len i32.ge_u br_if $done
        local.get $len local.get $base i32.sub local.tee $count i32.const 16 i32.gt_u
        if i32.const 16 local.set $count end
        local.get $input local.get $base i32.add v128.load local.set $chunk
        local.get $chunk i32.const 34 i8x16.splat i8x16.eq i8x16.bitmask local.set $quote
        local.get $chunk i32.const 92 i8x16.splat i8x16.eq i8x16.bitmask local.set $backslash
        local.get $chunk i32.const 123 i8x16.splat i8x16.eq
        local.get $chunk i32.const 125 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 91 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 93 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 58 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 44 i8x16.splat i8x16.eq v128.or
        i8x16.bitmask local.set $structural
        local.get $chunk i32.const 32 i8x16.splat i8x16.eq
        local.get $chunk i32.const 9 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 10 i8x16.splat i8x16.eq v128.or
        local.get $chunk i32.const 13 i8x16.splat i8x16.eq v128.or
        i8x16.bitmask local.set $whitespace
        i32.const 0 local.set $lane
        block $lanes_done
          loop $lanes
            local.get $lane local.get $count i32.ge_u br_if $lanes_done
            i32.const 1 local.get $lane i32.shl local.set $bit
            local.get $in_string
            if
              local.get $escaped
              if i32.const 0 local.set $escaped
              else
                local.get $backslash local.get $bit i32.and
                if i32.const 1 local.set $escaped
                else
                  local.get $quote local.get $bit i32.and
                  if
                    local.get $output local.get $output_count i32.const 2 i32.shl i32.add
                    local.get $base local.get $lane i32.add i32.store
                    local.get $output_count i32.const 1 i32.add local.set $output_count
                    i32.const 0 local.set $in_string
                  end
                end
              end
              i32.const 0 local.set $previous_atom
            else
              local.get $quote local.get $bit i32.and
              if
                local.get $output local.get $output_count i32.const 2 i32.shl i32.add
                local.get $base local.get $lane i32.add i32.store
                local.get $output_count i32.const 1 i32.add local.set $output_count
                i32.const 1 local.set $in_string
                i32.const 0 local.set $previous_atom
              else
                local.get $structural local.get $bit i32.and
                if
                  local.get $output local.get $output_count i32.const 2 i32.shl i32.add
                  local.get $base local.get $lane i32.add i32.store
                  local.get $output_count i32.const 1 i32.add local.set $output_count
                  i32.const 0 local.set $previous_atom
                else
                  local.get $whitespace local.get $bit i32.and
                  if i32.const 0 local.set $previous_atom
                  else
                    local.get $previous_atom i32.eqz
                    if
                      local.get $output local.get $output_count i32.const 2 i32.shl i32.add
                      local.get $base local.get $lane i32.add i32.store
                      local.get $output_count i32.const 1 i32.add local.set $output_count
                    end
                    i32.const 1 local.set $previous_atom
                  end
                end
              end
            end
            local.get $lane i32.const 1 i32.add local.set $lane br $lanes
          end
        end
        local.get $base i32.const 16 i32.add local.set $base br $blocks
      end
    end
    local.get $output_count
  )

  (func (export "f32_vector_dot") (param $left i32) (param $right i32)
    (param $elements i32) (result f32)
    (local $index i32) (local $sum v128)
    block $done
      loop $loop
        local.get $index local.get $elements i32.ge_u br_if $done
        local.get $sum
        local.get $left local.get $index i32.const 2 i32.shl i32.add v128.load
        local.get $right local.get $index i32.const 2 i32.shl i32.add v128.load
        f32x4.mul f32x4.add local.set $sum
        local.get $index i32.const 4 i32.add local.set $index br $loop
      end
    end
    local.get $sum f32x4.extract_lane 0
    local.get $sum f32x4.extract_lane 1 f32.add
    local.get $sum f32x4.extract_lane 2 f32.add
    local.get $sum f32x4.extract_lane 3 f32.add
  )

  (func (export "f32_vector_axpy") (param $target i32) (param $source i32)
    (param $elements i32) (param $scale f32)
    (local $index i32)
    block $done
      loop $loop
        local.get $index local.get $elements i32.ge_u br_if $done
        local.get $target local.get $index i32.const 2 i32.shl i32.add
        local.get $target local.get $index i32.const 2 i32.shl i32.add v128.load
        local.get $source local.get $index i32.const 2 i32.shl i32.add v128.load
        local.get $scale f32x4.splat f32x4.mul f32x4.add v128.store
        local.get $index i32.const 4 i32.add local.set $index br $loop
      end
    end
  )

  (func (export "bitset_and") (param $left i32) (param $right i32)
    (param $output i32) (param $words i32)
    (local $offset i32) (local $bytes i32)
    local.get $words i32.const 2 i32.shl local.set $bytes
    block $done
      loop $loop
        local.get $offset local.get $bytes i32.ge_u br_if $done
        local.get $output local.get $offset i32.add
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.and v128.store
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
  )

  (func (export "bitset_or") (param $left i32) (param $right i32)
    (param $output i32) (param $words i32)
    (local $offset i32) (local $bytes i32)
    local.get $words i32.const 2 i32.shl local.set $bytes
    block $done
      loop $loop
        local.get $offset local.get $bytes i32.ge_u br_if $done
        local.get $output local.get $offset i32.add
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.or v128.store
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
  )

  (func (export "bitset_xor") (param $left i32) (param $right i32)
    (param $output i32) (param $words i32)
    (local $offset i32) (local $bytes i32)
    local.get $words i32.const 2 i32.shl local.set $bytes
    block $done
      loop $loop
        local.get $offset local.get $bytes i32.ge_u br_if $done
        local.get $output local.get $offset i32.add
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.xor v128.store
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
  )

  (func (export "bitset_and_not") (param $left i32) (param $right i32)
    (param $output i32) (param $words i32)
    (local $offset i32) (local $bytes i32)
    local.get $words i32.const 2 i32.shl local.set $bytes
    block $done
      loop $loop
        local.get $offset local.get $bytes i32.ge_u br_if $done
        local.get $output local.get $offset i32.add
        local.get $left local.get $offset i32.add v128.load
        local.get $right local.get $offset i32.add v128.load v128.not v128.and v128.store
        local.get $offset i32.const 16 i32.add local.set $offset br $loop
      end
    end
  )

  (func (export "bitset_count") (param $input i32) (param $words i32) (result i32)
    (local $index i32) (local $count i32) (local $lanes v128)
    block $done
      loop $loop
        local.get $index local.get $words i32.ge_u br_if $done
        local.get $input local.get $index i32.const 2 i32.shl i32.add v128.load
        i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
        i32x4.extadd_pairwise_i16x8_u local.set $lanes
        local.get $count
        local.get $lanes i32x4.extract_lane 0 i32.add
        local.get $lanes i32x4.extract_lane 1 i32.add
        local.get $lanes i32x4.extract_lane 2 i32.add
        local.get $lanes i32x4.extract_lane 3 i32.add local.set $count
        local.get $index i32.const 4 i32.add local.set $index br $loop
      end
    end
    local.get $count
  )

  (func (export "bitset_intersection_count") (param $left i32) (param $right i32)
    (param $words i32) (result i32)
    (local $index i32) (local $count i32) (local $lanes v128)
    block $done
      loop $loop
        local.get $index local.get $words i32.ge_u br_if $done
        local.get $left local.get $index i32.const 2 i32.shl i32.add v128.load
        local.get $right local.get $index i32.const 2 i32.shl i32.add v128.load
        v128.and i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
        i32x4.extadd_pairwise_i16x8_u local.set $lanes
        local.get $count
        local.get $lanes i32x4.extract_lane 0 i32.add
        local.get $lanes i32x4.extract_lane 1 i32.add
        local.get $lanes i32x4.extract_lane 2 i32.add
        local.get $lanes i32x4.extract_lane 3 i32.add local.set $count
        local.get $index i32.const 4 i32.add local.set $index br $loop
      end
    end
    local.get $count
  )
)
