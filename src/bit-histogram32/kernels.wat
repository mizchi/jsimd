(module
  (memory (export "memory") 1)

  (func $flush
    (param $output i32) (param $low i32) (param $high i32)
    (local $bytes v128) (local $halves v128)
    local.get $low v128.load local.set $bytes
    local.get $bytes i16x8.extend_low_i8x16_u local.set $halves
    local.get $output local.get $output v128.load
    local.get $halves i32x4.extend_low_i16x8_u i32x4.add v128.store
    local.get $output local.get $output v128.load offset=16
    local.get $halves i32x4.extend_high_i16x8_u i32x4.add v128.store offset=16
    local.get $bytes i16x8.extend_high_i8x16_u local.set $halves
    local.get $output local.get $output v128.load offset=32
    local.get $halves i32x4.extend_low_i16x8_u i32x4.add v128.store offset=32
    local.get $output local.get $output v128.load offset=48
    local.get $halves i32x4.extend_high_i16x8_u i32x4.add v128.store offset=48

    local.get $high v128.load local.set $bytes
    local.get $bytes i16x8.extend_low_i8x16_u local.set $halves
    local.get $output local.get $output v128.load offset=64
    local.get $halves i32x4.extend_low_i16x8_u i32x4.add v128.store offset=64
    local.get $output local.get $output v128.load offset=80
    local.get $halves i32x4.extend_high_i16x8_u i32x4.add v128.store offset=80
    local.get $bytes i16x8.extend_high_i8x16_u local.set $halves
    local.get $output local.get $output v128.load offset=96
    local.get $halves i32x4.extend_low_i16x8_u i32x4.add v128.store offset=96
    local.get $output local.get $output v128.load offset=112
    local.get $halves i32x4.extend_high_i16x8_u i32x4.add v128.store offset=112)

  ;; Expand two source bytes at a time into 16 one-byte bit counters. Byte
  ;; accumulators flush before their unsigned 8-bit lanes can overflow.
  (func (export "add")
    (param $input i32) (param $length i32) (param $output i32)
    (param $low_scratch i32) (param $high_scratch i32)
    (local $index i32) (local $batch i32) (local $word v128)
    (local $low v128) (local $high v128)
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $input local.get $index i32.const 2 i32.shl i32.add i32.load
      i32x4.splat local.set $word

      local.get $low
      local.get $word
      v128.const i8x16 0 0 0 0 0 0 0 0 1 1 1 1 1 1 1 1
      i8x16.swizzle
      v128.const i8x16 1 2 4 8 16 32 64 -128 1 2 4 8 16 32 64 -128
      v128.and v128.const i32x4 0 0 0 0 i8x16.ne i32.const 7 i8x16.shr_u
      i8x16.add local.set $low

      local.get $high
      local.get $word
      v128.const i8x16 2 2 2 2 2 2 2 2 3 3 3 3 3 3 3 3
      i8x16.swizzle
      v128.const i8x16 1 2 4 8 16 32 64 -128 1 2 4 8 16 32 64 -128
      v128.and v128.const i32x4 0 0 0 0 i8x16.ne i32.const 7 i8x16.shr_u
      i8x16.add local.set $high

      local.get $batch i32.const 1 i32.add local.tee $batch i32.const 255 i32.eq
      if
        local.get $low_scratch local.get $low v128.store
        local.get $high_scratch local.get $high v128.store
        local.get $output local.get $low_scratch local.get $high_scratch call $flush
        v128.const i32x4 0 0 0 0 local.set $low
        v128.const i32x4 0 0 0 0 local.set $high
        i32.const 0 local.set $batch
      end
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end
    local.get $low_scratch local.get $low v128.store
    local.get $high_scratch local.get $high v128.store
    local.get $output local.get $low_scratch local.get $high_scratch call $flush)
)
