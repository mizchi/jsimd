(module
  (memory (export "memory") 1)
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
)

