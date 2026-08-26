(module
  (memory (export "memory") 1)

  (func $mix32 (param $hash i32) (result i32)
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x7feb352d i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 15 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x846ca68b i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor)

  (func $hash
    (param $pointer i32) (param $length i32) (param $seed i32)
    (param $multiplier i32) (param $rotate i32) (result i32)
    (local $index i32) (local $value i32)
    local.get $seed local.set $value
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $value
      local.get $pointer local.get $index i32.add i32.load8_u i32.xor
      local.get $multiplier i32.mul
      local.get $rotate i32.rotl local.set $value
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $value call $mix32)

  (func $hash1 (param $pointer i32) (param $length i32) (result i32)
    local.get $pointer local.get $length
    i32.const 0x811c9dc5 i32.const 0x01000193 i32.const 0 call $hash)

  (func $hash2 (param $pointer i32) (param $length i32) (result i32)
    local.get $pointer local.get $length
    i32.const 0x9e3779b9 i32.const 0x27d4eb2d i32.const 13 call $hash)

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

  (func $slot_for
    (param $displacements i32) (param $bucket_count i32) (param $count i32)
    (param $key i32) (param $key_length i32) (result i32)
    (local $hash i32) (local $displacement i32)
    local.get $key local.get $key_length call $hash1 local.set $hash
    local.get $displacements
    local.get $hash local.get $bucket_count i32.rem_u i32.const 2 i32.shl i32.add
    i32.load local.tee $displacement i32.const 0x80000000 i32.eq
    if i32.const -1 return end
    local.get $displacement i32.const 0 i32.lt_s
    if (result i32)
      i32.const 0 local.get $displacement i32.sub i32.const 1 i32.sub
    else
      local.get $key local.get $key_length call $hash2
      local.get $displacement i32.const 0x9e3779b9 i32.mul i32.xor
      call $mix32 local.get $count i32.rem_u
    end)

  (func $lookup (export "lookup")
    (param $displacements i32) (param $bucket_count i32)
    (param $offsets i32) (param $lengths i32) (param $count i32)
    (param $arena i32) (param $key i32) (param $key_length i32) (result i32)
    (local $slot i32)
    local.get $count i32.eqz if i32.const -1 return end
    local.get $displacements local.get $bucket_count local.get $count
    local.get $key local.get $key_length call $slot_for local.tee $slot
    i32.const 0 i32.lt_s if i32.const -1 return end
    local.get $lengths local.get $slot i32.const 2 i32.shl i32.add i32.load
    local.get $key_length i32.ne if i32.const -1 return end
    local.get $arena
    local.get $offsets local.get $slot i32.const 2 i32.shl i32.add i32.load i32.add
    local.get $key local.get $key_length call $key_equal
    if (result i32) local.get $slot else i32.const -1 end)

  (func (export "lookup_many")
    (param $displacements i32) (param $bucket_count i32)
    (param $key_offsets i32) (param $key_lengths i32) (param $key_count i32)
    (param $arena i32) (param $queries i32) (param $query_offsets i32)
    (param $query_count i32) (param $output i32) (result i32)
    (local $index i32) (local $start i32) (local $length i32)
    (local $slot i32) (local $found i32)
    block $done loop $loop
      local.get $index local.get $query_count i32.ge_u br_if $done
      local.get $query_offsets local.get $index i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $query_offsets local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $displacements local.get $bucket_count local.get $key_offsets local.get $key_lengths
      local.get $key_count local.get $arena local.get $queries local.get $start i32.add local.get $length
      call $lookup local.tee $slot
      local.get $output local.get $index i32.const 2 i32.shl i32.add local.get $slot i32.store
      local.get $slot i32.const 0 i32.ge_s
      if local.get $found i32.const 1 i32.add local.set $found end
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $found)

  (func (export "lookup_values_many")
    (param $displacements i32) (param $bucket_count i32)
    (param $key_offsets i32) (param $key_lengths i32) (param $key_count i32)
    (param $arena i32) (param $table_values i32)
    (param $queries i32) (param $query_offsets i32) (param $query_count i32)
    (param $output_values i32) (param $present i32) (result i32)
    (local $index i32) (local $start i32) (local $length i32)
    (local $slot i32) (local $is_present i32) (local $found i32)
    block $done loop $loop
      local.get $index local.get $query_count i32.ge_u br_if $done
      local.get $query_offsets local.get $index i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $query_offsets local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $displacements local.get $bucket_count local.get $key_offsets local.get $key_lengths
      local.get $key_count local.get $arena local.get $queries local.get $start i32.add local.get $length
      call $lookup local.tee $slot i32.const 0 i32.ge_s local.set $is_present
      local.get $present local.get $index i32.add local.get $is_present i32.store8
      local.get $output_values local.get $index i32.const 2 i32.shl i32.add
      local.get $is_present
      if (result i32)
        local.get $table_values local.get $slot i32.const 2 i32.shl i32.add i32.load
      else i32.const 0 end
      i32.store
      local.get $found local.get $is_present i32.add local.set $found
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end
    local.get $found)
)
