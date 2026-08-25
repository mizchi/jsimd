(module
  (memory (export "memory") 1)
  (func $distance (param $left i32) (param $right i32) (param $stride i32) (result i32)
    (local $offset i32) (local $bytes v128) (local $pairs v128) (local $quads v128) (local $count i32)
    block $done loop $loop
      local.get $offset local.get $stride i32.ge_u br_if $done
      local.get $left local.get $offset i32.add v128.load
      local.get $right local.get $offset i32.add v128.load v128.xor i8x16.popcnt local.set $bytes
      local.get $bytes i16x8.extadd_pairwise_i8x16_u local.set $pairs
      local.get $pairs i32x4.extadd_pairwise_i16x8_u local.set $quads
      local.get $count local.get $quads i32x4.extract_lane 0 i32.add
      local.get $quads i32x4.extract_lane 1 i32.add
      local.get $quads i32x4.extract_lane 2 i32.add
      local.get $quads i32x4.extract_lane 3 i32.add local.set $count
      local.get $offset i32.const 16 i32.add local.set $offset br $loop
    end end
    local.get $count
  )
  (func (export "distance_many")
    (param $vectors i32) (param $query i32) (param $count i32) (param $stride i32) (param $output i32)
    (local $index i32)
    block $done loop $loop
      local.get $index local.get $count i32.ge_u br_if $done
      local.get $output local.get $index i32.const 2 i32.shl i32.add
      local.get $vectors local.get $index local.get $stride i32.mul i32.add
      local.get $query local.get $stride call $distance i32.store
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
  )
)
