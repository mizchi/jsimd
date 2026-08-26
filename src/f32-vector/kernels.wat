(module
  (memory (export "memory") 1)
  (func $horizontal_sum (param $sum v128) (result f32)
    local.get $sum f32x4.extract_lane 0
    local.get $sum f32x4.extract_lane 1 f32.add
    local.get $sum f32x4.extract_lane 2 f32.add
    local.get $sum f32x4.extract_lane 3 f32.add)

  (func $dot (export "dot") (param $left i32) (param $right i32) (param $n i32) (result f32)
    (local $i i32) (local $sum v128)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $sum
      local.get $left local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $i i32.const 2 i32.shl i32.add v128.load
      f32x4.mul f32x4.add local.set $sum
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
    local.get $sum call $horizontal_sum)

  (func (export "squared_distance")
    (param $left i32) (param $right i32) (param $n i32) (result f32)
    (local $i i32) (local $sum v128) (local $delta v128)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $left local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $right local.get $i i32.const 2 i32.shl i32.add v128.load
      f32x4.sub local.tee $delta
      local.get $delta f32x4.mul local.get $sum f32x4.add local.set $sum
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
    local.get $sum call $horizontal_sum)

  (func (export "norm") (param $value i32) (param $n i32) (result f32)
    local.get $value local.get $value local.get $n call $dot f32.sqrt)

  (func (export "cosine_similarity")
    (param $left i32) (param $right i32) (param $n i32) (result f32)
    (local $i i32) (local $left_lanes v128) (local $right_lanes v128)
    (local $dot_sum v128) (local $left_sum v128) (local $right_sum v128)
    (local $dot_value f32) (local $left_value f32) (local $right_value f32)
    block $done loop $loop
      local.get $i local.get $n i32.ge_u br_if $done
      local.get $left local.get $i i32.const 2 i32.shl i32.add v128.load local.set $left_lanes
      local.get $right local.get $i i32.const 2 i32.shl i32.add v128.load local.set $right_lanes
      local.get $left_lanes local.get $right_lanes f32x4.mul
      local.get $dot_sum f32x4.add local.set $dot_sum
      local.get $left_lanes local.get $left_lanes f32x4.mul
      local.get $left_sum f32x4.add local.set $left_sum
      local.get $right_lanes local.get $right_lanes f32x4.mul
      local.get $right_sum f32x4.add local.set $right_sum
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end
    local.get $dot_sum call $horizontal_sum local.set $dot_value
    local.get $left_sum call $horizontal_sum local.set $left_value
    local.get $right_sum call $horizontal_sum local.set $right_value
    local.get $dot_value
    local.get $left_value local.get $right_value f32.mul f32.sqrt
    f32.div)

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
