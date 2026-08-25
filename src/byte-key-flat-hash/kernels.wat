(module
  (memory (export "memory") 1)

  (func $hash_bytes (param $pointer i32) (param $length i32) (result i32)
    (local $index i32) (local $hash i32)
    i32.const 0x811c9dc5 local.set $hash
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $hash
      local.get $pointer local.get $index i32.add i32.load8_u
      i32.xor i32.const 0x01000193 i32.mul local.set $hash
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x7feb352d i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 15 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x846ca68b i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor)

  (func $key_equal
    (param $left i32) (param $right i32) (param $length i32) (result i32)
    block $blocks_done loop $blocks
      local.get $length i32.const 16 i32.lt_u br_if $blocks_done
      local.get $left v128.load
      local.get $right v128.load
      i8x16.eq i8x16.bitmask i32.const 65535 i32.ne
      if i32.const 0 return end
      local.get $left i32.const 16 i32.add local.set $left
      local.get $right i32.const 16 i32.add local.set $right
      local.get $length i32.const 16 i32.sub local.set $length
      br $blocks
    end end
    block $tail_done loop $tail
      local.get $length i32.eqz br_if $tail_done
      local.get $left i32.load8_u local.get $right i32.load8_u i32.ne
      if i32.const 0 return end
      local.get $left i32.const 1 i32.add local.set $left
      local.get $right i32.const 1 i32.add local.set $right
      local.get $length i32.const 1 i32.sub local.set $length
      br $tail
    end end
    i32.const 1)

  (func (export "init_controls") (param $controls i32) (param $capacity i32)
    local.get $controls i32.const 128 local.get $capacity memory.fill)

  ;; Returns (found << 32) | slot.
  (func $probe
    (param $controls i32) (param $offsets i32) (param $lengths i32)
    (param $capacity i32) (param $arena i32) (param $key i32) (param $key_length i32)
    (result i64)
    (local $hash i32) (local $fingerprint i32) (local $offset i32)
    (local $matches i32) (local $empties i32) (local $deleted i32)
    (local $lane i32) (local $slot i32) (local $first_deleted i32) (local $group v128)
    local.get $key local.get $key_length call $hash_bytes local.tee $hash
    local.get $capacity i32.const 1 i32.sub i32.and i32.const -16 i32.and local.set $offset
    local.get $hash i32.const 25 i32.shr_u local.set $fingerprint
    i32.const -1 local.set $first_deleted
    loop $groups
      local.get $controls local.get $offset i32.add v128.load local.tee $group
      local.get $fingerprint i8x16.splat i8x16.eq i8x16.bitmask local.set $matches
      block $matches_done loop $matches_loop
        local.get $matches i32.eqz br_if $matches_done
        local.get $matches i32.ctz local.set $lane
        local.get $offset local.get $lane i32.add
        local.get $capacity i32.const 1 i32.sub i32.and local.set $slot
        local.get $lengths local.get $slot i32.const 2 i32.shl i32.add i32.load
        local.get $key_length i32.eq
        if
          local.get $arena
          local.get $offsets local.get $slot i32.const 2 i32.shl i32.add i32.load i32.add
          local.get $key local.get $key_length call $key_equal
          if
            i64.const 0x100000000 local.get $slot i64.extend_i32_u i64.or return
          end
        end
        local.get $matches local.get $matches i32.const 1 i32.sub i32.and local.set $matches
        br $matches_loop
      end end
      local.get $first_deleted i32.const -1 i32.eq
      if
        local.get $group i32.const 254 i8x16.splat i8x16.eq i8x16.bitmask local.set $deleted
        local.get $deleted
        if
          local.get $offset local.get $deleted i32.ctz i32.add
          local.get $capacity i32.const 1 i32.sub i32.and local.set $first_deleted
        end
      end
      local.get $group i32.const 128 i8x16.splat i8x16.eq i8x16.bitmask
      local.tee $empties
      if
        local.get $first_deleted i32.const -1 i32.ne
        if (result i32) local.get $first_deleted
        else
          local.get $offset local.get $empties i32.ctz i32.add
          local.get $capacity i32.const 1 i32.sub i32.and
        end
        i64.extend_i32_u return
      end
      local.get $offset i32.const 16 i32.add
      local.get $capacity i32.const 1 i32.sub i32.and local.set $offset
      br $groups
    end
    unreachable)

  (func $find (export "find")
    (param $controls i32) (param $offsets i32) (param $lengths i32)
    (param $capacity i32) (param $arena i32) (param $key i32) (param $key_length i32)
    (result i32) (local $result i64)
    local.get $controls local.get $offsets local.get $lengths local.get $capacity
    local.get $arena local.get $key local.get $key_length call $probe
    local.tee $result i64.const 32 i64.shr_u i32.wrap_i64
    if (result i32) local.get $result i32.wrap_i64 else i32.const -1 end)

  (func $insert_map
    (param $controls i32) (param $offsets i32) (param $lengths i32) (param $values i32)
    (param $capacity i32) (param $arena i32) (param $key i32) (param $key_length i32)
    (param $key_offset i32) (param $value i32) (result i32)
    (local $result i64) (local $slot i32) (local $inserted i32)
    local.get $controls local.get $offsets local.get $lengths local.get $capacity
    local.get $arena local.get $key local.get $key_length call $probe
    local.tee $result i64.const 32 i64.shr_u i32.wrap_i64 i32.eqz local.set $inserted
    local.get $result i32.wrap_i64 local.set $slot
    local.get $inserted
    if
      local.get $offsets local.get $slot i32.const 2 i32.shl i32.add
      local.get $key_offset i32.store
      local.get $lengths local.get $slot i32.const 2 i32.shl i32.add
      local.get $key_length i32.store
      local.get $controls local.get $slot i32.add
      local.get $key local.get $key_length call $hash_bytes i32.const 25 i32.shr_u i32.store8
    end
    local.get $values local.get $slot i32.const 2 i32.shl i32.add local.get $value i32.store
    local.get $inserted)

  (func (export "insert_map")
    (param $controls i32) (param $offsets i32) (param $lengths i32) (param $values i32)
    (param $capacity i32) (param $arena i32) (param $key i32) (param $key_length i32)
    (param $key_offset i32) (param $value i32) (result i32)
    local.get $controls local.get $offsets local.get $lengths local.get $values
    local.get $capacity local.get $arena local.get $key local.get $key_length
    local.get $key_offset local.get $value call $insert_map)

  (func (export "remove")
    (param $controls i32) (param $offsets i32) (param $lengths i32)
    (param $capacity i32) (param $arena i32) (param $key i32) (param $key_length i32)
    (result i32) (local $slot i32)
    local.get $controls local.get $offsets local.get $lengths local.get $capacity
    local.get $arena local.get $key local.get $key_length call $find
    local.tee $slot i32.const 0 i32.lt_s
    if i32.const 0 return end
    local.get $controls local.get $slot i32.add i32.const 254 i32.store8
    i32.const 1)

  (func (export "insert_map_many")
    (param $controls i32) (param $key_offsets i32) (param $key_lengths i32)
    (param $table_values i32) (param $capacity i32) (param $arena i32)
    (param $input_base_offset i32) (param $input_offsets i32)
    (param $input_values i32) (param $count i32) (result i32)
    (local $index i32) (local $start i32) (local $length i32) (local $inserted i32)
    block $done loop $loop
      local.get $index local.get $count i32.ge_u br_if $done
      local.get $input_offsets local.get $index i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $input_offsets local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $inserted
      local.get $controls local.get $key_offsets local.get $key_lengths local.get $table_values
      local.get $capacity local.get $arena
      local.get $arena local.get $input_base_offset i32.add local.get $start i32.add
      local.get $length local.get $input_base_offset local.get $start i32.add
      local.get $input_values local.get $index i32.const 2 i32.shl i32.add i32.load
      call $insert_map i32.add local.set $inserted
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $inserted)

  (func (export "lookup_many")
    (param $controls i32) (param $key_offsets i32) (param $key_lengths i32)
    (param $table_values i32) (param $capacity i32) (param $arena i32)
    (param $queries i32) (param $query_offsets i32) (param $count i32)
    (param $output i32) (param $present i32) (result i32)
    (local $index i32) (local $start i32) (local $length i32)
    (local $slot i32) (local $found i32) (local $found_count i32)
    block $done loop $loop
      local.get $index local.get $count i32.ge_u br_if $done
      local.get $query_offsets local.get $index i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $query_offsets local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $controls local.get $key_offsets local.get $key_lengths local.get $capacity
      local.get $arena local.get $queries local.get $start i32.add local.get $length
      call $find local.tee $slot i32.const 0 i32.ge_s local.set $found
      local.get $present local.get $index i32.add local.get $found i32.store8
      local.get $output local.get $index i32.const 2 i32.shl i32.add
      local.get $found
      if (result i32)
        local.get $table_values local.get $slot i32.const 2 i32.shl i32.add i32.load
      else i32.const 0 end
      i32.store
      local.get $found_count local.get $found i32.add local.set $found_count
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $found_count)

  (func (export "rehash_map")
    (param $old_controls i32) (param $old_offsets i32) (param $old_lengths i32)
    (param $old_values i32) (param $old_capacity i32) (param $arena i32)
    (param $new_controls i32) (param $new_offsets i32) (param $new_lengths i32)
    (param $new_values i32) (param $new_capacity i32)
    (local $slot i32) (local $key_offset i32) (local $key_length i32)
    block $done loop $loop
      local.get $slot local.get $old_capacity i32.ge_u br_if $done
      local.get $old_controls local.get $slot i32.add i32.load8_u i32.const 128 i32.lt_u
      if
        local.get $old_offsets local.get $slot i32.const 2 i32.shl i32.add i32.load local.set $key_offset
        local.get $old_lengths local.get $slot i32.const 2 i32.shl i32.add i32.load local.set $key_length
        local.get $new_controls local.get $new_offsets local.get $new_lengths local.get $new_values
        local.get $new_capacity local.get $arena local.get $arena local.get $key_offset i32.add
        local.get $key_length local.get $key_offset
        local.get $old_values local.get $slot i32.const 2 i32.shl i32.add i32.load
        call $insert_map drop
      end
      local.get $slot i32.const 1 i32.add local.set $slot
      br $loop
    end end)
)
