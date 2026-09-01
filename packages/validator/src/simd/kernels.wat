(module
  (memory (export "memory") 1)

  (func (export "first_i32_outside")
    (param $input i32) (param $length i32) (param $minimum i32) (param $maximum i32)
    (result i32)
    (local $index i32) (local $vector_end i32) (local $values v128) (local $bits i32)
    local.get $length i32.const -4 i32.and local.set $vector_end
    block $vectors_done loop $vectors
      local.get $index local.get $vector_end i32.ge_u br_if $vectors_done
      local.get $input local.get $index i32.const 2 i32.shl i32.add v128.load local.set $values
      local.get $values local.get $minimum i32x4.splat i32x4.lt_s
      local.get $values local.get $maximum i32x4.splat i32x4.gt_s
      v128.or i32x4.bitmask local.set $bits
      local.get $bits
      if
        local.get $index local.get $bits i32.ctz i32.add return
      end
      local.get $index i32.const 4 i32.add local.set $index
      br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.const 2 i32.shl i32.add i32.load
      local.tee $bits local.get $minimum i32.lt_s
      local.get $bits local.get $maximum i32.gt_s i32.or
      if local.get $index return end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end
    i32.const -1
  )

  (func (export "first_u32_outside")
    (param $input i32) (param $length i32) (param $minimum i32) (param $maximum i32)
    (result i32)
    (local $index i32) (local $vector_end i32) (local $values v128) (local $bits i32)
    local.get $length i32.const -4 i32.and local.set $vector_end
    block $vectors_done loop $vectors
      local.get $index local.get $vector_end i32.ge_u br_if $vectors_done
      local.get $input local.get $index i32.const 2 i32.shl i32.add v128.load local.set $values
      local.get $values local.get $minimum i32x4.splat i32x4.lt_u
      local.get $values local.get $maximum i32x4.splat i32x4.gt_u
      v128.or i32x4.bitmask local.set $bits
      local.get $bits
      if
        local.get $index local.get $bits i32.ctz i32.add return
      end
      local.get $index i32.const 4 i32.add local.set $index
      br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.const 2 i32.shl i32.add i32.load
      local.tee $bits local.get $minimum i32.lt_u
      local.get $bits local.get $maximum i32.gt_u i32.or
      if local.get $index return end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end
    i32.const -1
  )

  (func (export "first_u8_outside")
    (param $input i32) (param $length i32) (param $minimum i32) (param $maximum i32)
    (result i32)
    (local $index i32) (local $vector_end i32) (local $values v128) (local $bits i32)
    local.get $length i32.const -16 i32.and local.set $vector_end
    block $vectors_done loop $vectors
      local.get $index local.get $vector_end i32.ge_u br_if $vectors_done
      local.get $input local.get $index i32.add v128.load local.set $values
      local.get $values local.get $minimum i8x16.splat i8x16.lt_u
      local.get $values local.get $maximum i8x16.splat i8x16.gt_u
      v128.or i8x16.bitmask local.set $bits
      local.get $bits
      if
        local.get $index local.get $bits i32.ctz i32.add return
      end
      local.get $index i32.const 16 i32.add local.set $index
      br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.add i32.load8_u
      local.tee $bits local.get $minimum i32.lt_u
      local.get $bits local.get $maximum i32.gt_u i32.or
      if local.get $index return end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end
    i32.const -1
  )

  (func (export "first_f32_outside")
    (param $input i32) (param $length i32) (param $minimum f32) (param $maximum f32)
    (result i32)
    (local $index i32) (local $vector_end i32) (local $values v128) (local $bits i32)
    (local $value f32)
    local.get $length i32.const -4 i32.and local.set $vector_end
    block $vectors_done loop $vectors
      local.get $index local.get $vector_end i32.ge_u br_if $vectors_done
      local.get $input local.get $index i32.const 2 i32.shl i32.add v128.load local.set $values
      local.get $values local.get $minimum f32x4.splat f32x4.lt
      local.get $values local.get $maximum f32x4.splat f32x4.gt
      v128.or
      local.get $values local.get $values f32x4.ne
      v128.or i32x4.bitmask local.set $bits
      local.get $bits
      if
        local.get $index local.get $bits i32.ctz i32.add return
      end
      local.get $index i32.const 4 i32.add local.set $index
      br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.const 2 i32.shl i32.add f32.load local.set $value
      local.get $value local.get $value f32.ne
      local.get $value local.get $minimum f32.lt i32.or
      local.get $value local.get $maximum f32.gt i32.or
      if local.get $index return end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end
    i32.const -1
  )

  (func (export "first_f64_outside")
    (param $input i32) (param $length i32) (param $minimum f64) (param $maximum f64)
    (result i32)
    (local $index i32) (local $vector_end i32) (local $values v128) (local $bits i32)
    (local $value f64)
    local.get $length i32.const -2 i32.and local.set $vector_end
    block $vectors_done loop $vectors
      local.get $index local.get $vector_end i32.ge_u br_if $vectors_done
      local.get $input local.get $index i32.const 3 i32.shl i32.add v128.load local.set $values
      local.get $values local.get $minimum f64x2.splat f64x2.lt
      local.get $values local.get $maximum f64x2.splat f64x2.gt
      v128.or
      local.get $values local.get $values f64x2.ne
      v128.or i64x2.bitmask local.set $bits
      local.get $bits
      if
        local.get $index local.get $bits i32.ctz i32.add return
      end
      local.get $index i32.const 2 i32.add local.set $index
      br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.const 3 i32.shl i32.add f64.load local.set $value
      local.get $value local.get $value f64.ne
      local.get $value local.get $minimum f64.lt i32.or
      local.get $value local.get $maximum f64.gt i32.or
      if local.get $index return end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end
    i32.const -1
  )
)
