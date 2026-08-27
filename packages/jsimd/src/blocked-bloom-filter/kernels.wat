(module
  (memory (export "memory") 1)

  (func $mix (param $value i32) (result i32)
    local.get $value local.get $value i32.const 16 i32.shr_u i32.xor local.set $value
    local.get $value i32.const 0x7feb352d i32.mul local.set $value
    local.get $value local.get $value i32.const 15 i32.shr_u i32.xor local.set $value
    local.get $value i32.const 0x846ca68b i32.mul local.set $value
    local.get $value local.get $value i32.const 16 i32.shr_u i32.xor
  )

  (func $mask (param $hash i32) (result v128)
    (local $result v128)
    local.get $result i32.const 1 local.get $hash i32.const 31 i32.and i32.shl
    i32x4.replace_lane 0 local.set $result
    local.get $result i32.const 1 local.get $hash i32.const 8 i32.shr_u i32.const 31 i32.and i32.shl
    i32x4.replace_lane 1 local.set $result
    local.get $result i32.const 1 local.get $hash i32.const 16 i32.shr_u i32.const 31 i32.and i32.shl
    i32x4.replace_lane 2 local.set $result
    local.get $result i32.const 1 local.get $hash i32.const 24 i32.shr_u i32.const 31 i32.and i32.shl
    i32x4.replace_lane 3
  )

  (func (export "add_many")
    (param $blocks i32) (param $block_count i32) (param $keys i32) (param $length i32)
    (local $index i32) (local $hash i32) (local $bit_hash i32)
    (local $address i32) (local $mask v128)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $keys local.get $index i32.const 2 i32.shl i32.add i32.load call $mix local.set $hash
      local.get $blocks local.get $hash local.get $block_count i32.rem_u i32.const 4 i32.shl i32.add
      local.set $address
      local.get $hash i32.const 0x9e3779b9 i32.xor call $mix local.set $bit_hash
      local.get $bit_hash call $mask local.set $mask
      local.get $address local.get $address v128.load local.get $mask v128.or v128.store
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
  )

  (func (export "may_contain_many")
    (param $blocks i32) (param $block_count i32) (param $keys i32)
    (param $output i32) (param $length i32) (result i32)
    (local $index i32) (local $hash i32) (local $bit_hash i32)
    (local $address i32) (local $mask v128)
    (local $present i32) (local $count i32)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $keys local.get $index i32.const 2 i32.shl i32.add i32.load call $mix local.set $hash
      local.get $blocks local.get $hash local.get $block_count i32.rem_u i32.const 4 i32.shl i32.add
      local.set $address
      local.get $hash i32.const 0x9e3779b9 i32.xor call $mix local.set $bit_hash
      local.get $bit_hash call $mask local.set $mask
      local.get $address v128.load local.get $mask v128.and local.get $mask i32x4.eq i32x4.all_true
      local.set $present
      local.get $output local.get $index i32.add local.get $present i32.store8
      local.get $count local.get $present i32.add local.set $count
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $count
  )

  (func (export "merge") (param $blocks i32) (param $other i32) (param $block_count i32)
    (local $index i32) (local $offset i32)
    block $done loop $loop
      local.get $index local.get $block_count i32.ge_u br_if $done
      local.get $index i32.const 4 i32.shl local.set $offset
      local.get $blocks local.get $offset i32.add
      local.get $blocks local.get $offset i32.add v128.load
      local.get $other local.get $offset i32.add v128.load v128.or v128.store
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
  )
)
