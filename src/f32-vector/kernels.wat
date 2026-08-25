(module
  (memory (export "memory") 1)
  (func (export "dot") (param $left i32) (param $right i32) (param $n i32) (result f32)
    (local $i i32) (local $sum v128)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $sum
      local.get $left local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $i i32.const 2 i32.shl i32.add v128.load
      f32x4.mul f32x4.add local.set $sum
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
    local.get $sum f32x4.extract_lane 0
    local.get $sum f32x4.extract_lane 1 f32.add
    local.get $sum f32x4.extract_lane 2 f32.add
    local.get $sum f32x4.extract_lane 3 f32.add
  )
  (func (export "axpy") (param $target i32) (param $source i32) (param $n i32) (param $scale f32)
    (local $i i32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $target local.get $i i32.const 2 i32.shl i32.add
      local.get $target local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $source local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $scale f32x4.splat f32x4.mul f32x4.add v128.store
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
  )
)
