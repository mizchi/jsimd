(module
  (memory (export "memory") 1)
  (func (export "and") (param $a i32) (param $b i32) (param $out i32) (param $words i32)
    (local $i i32) block $done loop $loop
      local.get $i local.get $words i32.const 2 i32.shl i32.ge_u br_if $done
      local.get $out local.get $i i32.add
      local.get $a local.get $i i32.add v128.load
      local.get $b local.get $i i32.add v128.load v128.and v128.store
      local.get $i i32.const 16 i32.add local.set $i br $loop
    end end)
  (func (export "or") (param $a i32) (param $b i32) (param $out i32) (param $words i32)
    (local $i i32) block $done loop $loop
      local.get $i local.get $words i32.const 2 i32.shl i32.ge_u br_if $done
      local.get $out local.get $i i32.add
      local.get $a local.get $i i32.add v128.load
      local.get $b local.get $i i32.add v128.load v128.or v128.store
      local.get $i i32.const 16 i32.add local.set $i br $loop
    end end)
  (func (export "xor") (param $a i32) (param $b i32) (param $out i32) (param $words i32)
    (local $i i32) block $done loop $loop
      local.get $i local.get $words i32.const 2 i32.shl i32.ge_u br_if $done
      local.get $out local.get $i i32.add
      local.get $a local.get $i i32.add v128.load
      local.get $b local.get $i i32.add v128.load v128.xor v128.store
      local.get $i i32.const 16 i32.add local.set $i br $loop
    end end)
  (func (export "and_not") (param $a i32) (param $b i32) (param $out i32) (param $words i32)
    (local $i i32) block $done loop $loop
      local.get $i local.get $words i32.const 2 i32.shl i32.ge_u br_if $done
      local.get $out local.get $i i32.add
      local.get $a local.get $i i32.add v128.load
      local.get $b local.get $i i32.add v128.load v128.not v128.and v128.store
      local.get $i i32.const 16 i32.add local.set $i br $loop
    end end)
  (func $horizontal_popcount (param $value v128) (result i32)
    (local $lanes v128)
    local.get $value i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
    i32x4.extadd_pairwise_i16x8_u local.set $lanes
    local.get $lanes i32x4.extract_lane 0
    local.get $lanes i32x4.extract_lane 1 i32.add
    local.get $lanes i32x4.extract_lane 2 i32.add
    local.get $lanes i32x4.extract_lane 3 i32.add)
  (func (export "count") (param $a i32) (param $words i32) (result i32)
    (local $i i32) (local $result i32)
    block $done loop $loop
      local.get $i local.get $words i32.ge_u br_if $done
      local.get $result
      local.get $a local.get $i i32.const 2 i32.shl i32.add v128.load
      call $horizontal_popcount i32.add local.set $result
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end local.get $result)
  (func (export "intersection_count") (param $a i32) (param $b i32) (param $words i32) (result i32)
    (local $i i32) (local $result i32)
    block $done loop $loop
      local.get $i local.get $words i32.ge_u br_if $done
      local.get $result
      local.get $a local.get $i i32.const 2 i32.shl i32.add v128.load
      local.get $b local.get $i i32.const 2 i32.shl i32.add v128.load v128.and
      call $horizontal_popcount i32.add local.set $result
      local.get $i i32.const 4 i32.add local.set $i br $loop
    end end local.get $result)
)
