(module
  (memory (export "memory") 1)

  (func $match (export "match_mask") (param $group i32) (param $fingerprint i32) (result i32)
    local.get $group v128.load
    local.get $fingerprint i8x16.splat i8x16.eq i8x16.bitmask)

  (func (export "empty_mask") (param $group i32) (result i32)
    local.get $group i32.const 128 call $match)

  (func (export "deleted_mask") (param $group i32) (result i32)
    local.get $group i32.const 254 call $match)

  (func (export "match_many")
    (param $group i32) (param $fingerprints i32) (param $output i32) (param $length i32)
    (local $index i32) (local $control v128)
    local.get $group v128.load local.set $control
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $output local.get $index i32.const 1 i32.shl i32.add
      local.get $control
      local.get $fingerprints local.get $index i32.add i32.load8_u
      i8x16.splat i8x16.eq i8x16.bitmask i32.store16
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end)

  (func (export "table_probe_many")
    (param $controls i32) (param $capacity i32) (param $hashes i32)
    (param $groups i32) (param $matches i32) (param $empty i32) (param $deleted i32)
    (param $length i32)
    (local $index i32) (local $hash i32) (local $offset i32) (local $group v128)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $hashes local.get $index i32.const 2 i32.shl i32.add i32.load
      local.tee $hash
      local.get $capacity i32.const 1 i32.sub i32.and i32.const -16 i32.and local.set $offset
      local.get $controls local.get $offset i32.add v128.load local.set $group
      local.get $groups local.get $index i32.const 2 i32.shl i32.add
      local.get $offset i32.store
      local.get $matches local.get $index i32.const 1 i32.shl i32.add
      local.get $group local.get $hash i32.const 25 i32.shr_u i8x16.splat
      i8x16.eq i8x16.bitmask i32.store16
      local.get $empty local.get $index i32.const 1 i32.shl i32.add
      local.get $group i32.const 128 i8x16.splat i8x16.eq i8x16.bitmask i32.store16
      local.get $deleted local.get $index i32.const 1 i32.shl i32.add
      local.get $group i32.const 254 i8x16.splat i8x16.eq i8x16.bitmask i32.store16
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end)
)
