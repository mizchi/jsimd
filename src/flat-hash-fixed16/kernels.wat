(module
  (memory (export "memory") 1)

  (func $hash (param $key i32) (result i32)
    (local $hash i32)
    local.get $key i32.load
    local.get $key i32.const 4 i32.add i32.load i32.const 7 i32.rotl i32.xor
    local.get $key i32.const 8 i32.add i32.load i32.const 13 i32.rotl i32.xor
    local.get $key i32.const 12 i32.add i32.load i32.const 21 i32.rotl i32.xor
    local.set $hash
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x7feb352d i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 15 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x846ca68b i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor)

  (func $key_equal (param $left i32) (param $right i32) (result i32)
    local.get $left v128.load
    local.get $right v128.load i8x16.eq i8x16.bitmask i32.const 65535 i32.eq)

  (func (export "init_controls") (param $controls i32) (param $capacity i32)
    local.get $controls i32.const 128 local.get $capacity memory.fill)

  ;; Returns (found << 32) | slot.
  (func $probe
    (param $controls i32) (param $keys i32) (param $capacity i32) (param $key i32)
    (result i64)
    (local $hash i32) (local $fingerprint i32) (local $offset i32)
    (local $matches i32) (local $empties i32) (local $deleted i32)
    (local $lane i32) (local $slot i32) (local $first_deleted i32) (local $group v128)
    local.get $key call $hash local.tee $hash
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
        local.get $keys local.get $slot i32.const 4 i32.shl i32.add
        local.get $key call $key_equal
        if
          i64.const 0x100000000 local.get $slot i64.extend_i32_u i64.or return
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
    (param $controls i32) (param $keys i32) (param $capacity i32) (param $key i32)
    (result i32) (local $result i64)
    local.get $controls local.get $keys local.get $capacity local.get $key call $probe
    local.tee $result i64.const 32 i64.shr_u i32.wrap_i64
    if (result i32) local.get $result i32.wrap_i64 else i32.const -1 end)

  (func $insert_map
    (param $controls i32) (param $keys i32) (param $values i32)
    (param $capacity i32) (param $key i32) (param $value i32) (result i32)
    (local $result i64) (local $slot i32) (local $inserted i32)
    local.get $controls local.get $keys local.get $capacity local.get $key call $probe
    local.tee $result i64.const 32 i64.shr_u i32.wrap_i64 i32.eqz local.set $inserted
    local.get $result i32.wrap_i64 local.set $slot
    local.get $inserted
    if
      local.get $keys local.get $slot i32.const 4 i32.shl i32.add
      local.get $key v128.load v128.store
      local.get $controls local.get $slot i32.add
      local.get $key call $hash i32.const 25 i32.shr_u i32.store8
    end
    local.get $values local.get $slot i32.const 2 i32.shl i32.add local.get $value i32.store
    local.get $inserted)

  (func (export "insert_map")
    (param $controls i32) (param $keys i32) (param $values i32)
    (param $capacity i32) (param $key i32) (param $value i32) (result i32)
    local.get $controls local.get $keys local.get $values
    local.get $capacity local.get $key local.get $value call $insert_map)

  (func (export "remove")
    (param $controls i32) (param $keys i32) (param $capacity i32) (param $key i32) (result i32)
    (local $slot i32)
    local.get $controls local.get $keys local.get $capacity local.get $key call $find
    local.tee $slot i32.const 0 i32.lt_s
    if i32.const 0 return end
    local.get $controls local.get $slot i32.add i32.const 254 i32.store8
    i32.const 1)

  (func (export "insert_map_many")
    (param $controls i32) (param $keys i32) (param $values i32) (param $capacity i32)
    (param $input_keys i32) (param $input_values i32) (param $length i32) (result i32)
    (local $index i32) (local $inserted i32)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $inserted
      local.get $controls local.get $keys local.get $values local.get $capacity
      local.get $input_keys local.get $index i32.const 4 i32.shl i32.add
      local.get $input_values local.get $index i32.const 2 i32.shl i32.add i32.load
      call $insert_map i32.add local.set $inserted
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $inserted)

  (func (export "lookup_many")
    (param $controls i32) (param $keys i32) (param $values i32) (param $capacity i32)
    (param $queries i32) (param $length i32) (param $output i32) (param $present i32)
    (result i32)
    (local $index i32) (local $slot i32) (local $found i32) (local $count i32)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $controls local.get $keys local.get $capacity
      local.get $queries local.get $index i32.const 4 i32.shl i32.add
      call $find local.tee $slot i32.const 0 i32.ge_s local.set $found
      local.get $present local.get $index i32.add local.get $found i32.store8
      local.get $output local.get $index i32.const 2 i32.shl i32.add
      local.get $found
      if (result i32)
        local.get $values local.get $slot i32.const 2 i32.shl i32.add i32.load
      else i32.const 0 end
      i32.store
      local.get $count local.get $found i32.add local.set $count
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $count)

  (func (export "rehash_map")
    (param $old_controls i32) (param $old_keys i32) (param $old_values i32)
    (param $old_capacity i32) (param $new_controls i32) (param $new_keys i32)
    (param $new_values i32) (param $new_capacity i32) (local $slot i32)
    block $done loop $loop
      local.get $slot local.get $old_capacity i32.ge_u br_if $done
      local.get $old_controls local.get $slot i32.add i32.load8_u i32.const 128 i32.lt_u
      if
        local.get $new_controls local.get $new_keys local.get $new_values local.get $new_capacity
        local.get $old_keys local.get $slot i32.const 4 i32.shl i32.add
        local.get $old_values local.get $slot i32.const 2 i32.shl i32.add i32.load
        call $insert_map drop
      end
      local.get $slot i32.const 1 i32.add local.set $slot br $loop
    end end)
)
