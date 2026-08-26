(module
  (memory (export "memory") 1)

  (func $copy (param $source i32) (param $output i32) (param $length i32)
    block $blocks_done loop $blocks
      local.get $length i32.const 16 i32.lt_u br_if $blocks_done
      local.get $output local.get $source v128.load v128.store
      local.get $source i32.const 16 i32.add local.set $source
      local.get $output i32.const 16 i32.add local.set $output
      local.get $length i32.const 16 i32.sub local.set $length
      br $blocks
    end end
    block $tail_done loop $tail
      local.get $length i32.eqz br_if $tail_done
      local.get $output local.get $source i32.load8_u i32.store8
      local.get $source i32.const 1 i32.add local.set $source
      local.get $output i32.const 1 i32.add local.set $output
      local.get $length i32.const 1 i32.sub local.set $length
      br $tail
    end end)

  (func $equal (param $left i32) (param $right i32) (param $length i32) (result i32)
    block $blocks_done loop $blocks
      local.get $length i32.const 16 i32.lt_u br_if $blocks_done
      local.get $left v128.load local.get $right v128.load
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

  (func $decode
    (param $anchor_offsets i32) (param $prefix_lengths i32)
    (param $suffix_offsets i32) (param $suffix_lengths i32) (param $arena i32)
    (param $id i32) (param $output i32) (result i32)
    (local $prefix i32) (local $suffix i32) (local $suffix_offset i32)
    local.get $prefix_lengths local.get $id i32.const 2 i32.shl i32.add i32.load local.set $prefix
    local.get $suffix_lengths local.get $id i32.const 2 i32.shl i32.add i32.load local.set $suffix
    local.get $suffix_offsets local.get $id i32.const 2 i32.shl i32.add i32.load local.set $suffix_offset
    local.get $arena
    local.get $anchor_offsets local.get $id i32.const 4 i32.shr_u i32.const 2 i32.shl i32.add i32.load
    i32.add local.get $output local.get $prefix call $copy
    local.get $arena local.get $suffix_offset i32.add
    local.get $output local.get $prefix i32.add local.get $suffix call $copy
    local.get $prefix local.get $suffix i32.add)

  (func $equals
    (param $anchor_offsets i32) (param $prefix_lengths i32)
    (param $suffix_offsets i32) (param $suffix_lengths i32) (param $arena i32)
    (param $id i32) (param $query i32) (param $query_length i32) (result i32)
    (local $prefix i32) (local $suffix i32) (local $suffix_offset i32)
    local.get $prefix_lengths local.get $id i32.const 2 i32.shl i32.add i32.load local.set $prefix
    local.get $suffix_lengths local.get $id i32.const 2 i32.shl i32.add i32.load local.set $suffix
    local.get $prefix local.get $suffix i32.add local.get $query_length i32.ne
    if i32.const 0 return end
    local.get $arena
    local.get $anchor_offsets local.get $id i32.const 4 i32.shr_u i32.const 2 i32.shl i32.add i32.load i32.add
    local.get $query local.get $prefix call $equal i32.eqz
    if i32.const 0 return end
    local.get $suffix_offsets local.get $id i32.const 2 i32.shl i32.add i32.load local.set $suffix_offset
    local.get $arena local.get $suffix_offset i32.add
    local.get $query local.get $prefix i32.add local.get $suffix call $equal)

  (func (export "decode")
    (param $anchor_offsets i32) (param $prefix_lengths i32)
    (param $suffix_offsets i32) (param $suffix_lengths i32) (param $arena i32)
    (param $id i32) (param $output i32) (result i32)
    local.get $anchor_offsets local.get $prefix_lengths local.get $suffix_offsets
    local.get $suffix_lengths local.get $arena local.get $id local.get $output call $decode)

  (func (export "equals")
    (param $anchor_offsets i32) (param $prefix_lengths i32)
    (param $suffix_offsets i32) (param $suffix_lengths i32) (param $arena i32)
    (param $id i32) (param $query i32) (param $query_length i32) (result i32)
    local.get $anchor_offsets local.get $prefix_lengths local.get $suffix_offsets
    local.get $suffix_lengths local.get $arena local.get $id local.get $query local.get $query_length
    call $equals)

  (func (export "equals_many")
    (param $anchor_offsets i32) (param $prefix_lengths i32)
    (param $suffix_offsets i32) (param $suffix_lengths i32) (param $arena i32)
    (param $ids i32) (param $queries i32) (param $offsets i32)
    (param $count i32) (param $output i32)
    (local $index i32) (local $start i32) (local $length i32)
    block $done loop $loop
      local.get $index local.get $count i32.ge_u br_if $done
      local.get $offsets local.get $index i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $offsets local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $output local.get $index i32.add
      local.get $anchor_offsets local.get $prefix_lengths local.get $suffix_offsets
      local.get $suffix_lengths local.get $arena
      local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
      local.get $queries local.get $start i32.add local.get $length call $equals i32.store8
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end)
)
