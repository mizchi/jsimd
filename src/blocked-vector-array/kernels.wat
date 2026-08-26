(module
  (memory (export "memory") 1)

  ;; Each block contains 64 vectors in dimension-major order. Sixteen SIMD
  ;; accumulators keep every candidate independent across the dimension loop.
  (func (export "squared_distance_many")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $output i32)
    (local $block i32) (local $blocks i32) (local $dimension i32)
    (local $input i32) (local $output_block i32) (local $query_lane v128)
    (local $delta v128)
    (local $s0 v128) (local $s1 v128) (local $s2 v128) (local $s3 v128)
    (local $s4 v128) (local $s5 v128) (local $s6 v128) (local $s7 v128)
    (local $s8 v128) (local $s9 v128) (local $s10 v128) (local $s11 v128)
    (local $s12 v128) (local $s13 v128) (local $s14 v128) (local $s15 v128)

    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u local.set $blocks
    block $done loop $block_loop
      local.get $block local.get $blocks i32.ge_u br_if $done

      v128.const i32x4 0 0 0 0 local.set $s0
      v128.const i32x4 0 0 0 0 local.set $s1
      v128.const i32x4 0 0 0 0 local.set $s2
      v128.const i32x4 0 0 0 0 local.set $s3
      v128.const i32x4 0 0 0 0 local.set $s4
      v128.const i32x4 0 0 0 0 local.set $s5
      v128.const i32x4 0 0 0 0 local.set $s6
      v128.const i32x4 0 0 0 0 local.set $s7
      v128.const i32x4 0 0 0 0 local.set $s8
      v128.const i32x4 0 0 0 0 local.set $s9
      v128.const i32x4 0 0 0 0 local.set $s10
      v128.const i32x4 0 0 0 0 local.set $s11
      v128.const i32x4 0 0 0 0 local.set $s12
      v128.const i32x4 0 0 0 0 local.set $s13
      v128.const i32x4 0 0 0 0 local.set $s14
      v128.const i32x4 0 0 0 0 local.set $s15
      i32.const 0 local.set $dimension

      block $dimensions_done loop $dimension_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $dimensions_done
        local.get $vectors
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 8 i32.shl i32.add local.set $input
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add
        v128.load32_splat local.set $query_lane

        local.get $input v128.load local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s0 f32x4.add local.set $s0
        local.get $input v128.load offset=16 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s1 f32x4.add local.set $s1
        local.get $input v128.load offset=32 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s2 f32x4.add local.set $s2
        local.get $input v128.load offset=48 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s3 f32x4.add local.set $s3
        local.get $input v128.load offset=64 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s4 f32x4.add local.set $s4
        local.get $input v128.load offset=80 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s5 f32x4.add local.set $s5
        local.get $input v128.load offset=96 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s6 f32x4.add local.set $s6
        local.get $input v128.load offset=112 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s7 f32x4.add local.set $s7
        local.get $input v128.load offset=128 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s8 f32x4.add local.set $s8
        local.get $input v128.load offset=144 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s9 f32x4.add local.set $s9
        local.get $input v128.load offset=160 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s10 f32x4.add local.set $s10
        local.get $input v128.load offset=176 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s11 f32x4.add local.set $s11
        local.get $input v128.load offset=192 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s12 f32x4.add local.set $s12
        local.get $input v128.load offset=208 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s13 f32x4.add local.set $s13
        local.get $input v128.load offset=224 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s14 f32x4.add local.set $s14
        local.get $input v128.load offset=240 local.get $query_lane f32x4.sub local.tee $delta
        local.get $delta f32x4.mul local.get $s15 f32x4.add local.set $s15

        local.get $dimension i32.const 1 i32.add local.set $dimension
        br $dimension_loop
      end end

      local.get $output local.get $block i32.const 8 i32.shl i32.add local.set $output_block
      local.get $output_block local.get $s0 v128.store
      local.get $output_block local.get $s1 v128.store offset=16
      local.get $output_block local.get $s2 v128.store offset=32
      local.get $output_block local.get $s3 v128.store offset=48
      local.get $output_block local.get $s4 v128.store offset=64
      local.get $output_block local.get $s5 v128.store offset=80
      local.get $output_block local.get $s6 v128.store offset=96
      local.get $output_block local.get $s7 v128.store offset=112
      local.get $output_block local.get $s8 v128.store offset=128
      local.get $output_block local.get $s9 v128.store offset=144
      local.get $output_block local.get $s10 v128.store offset=160
      local.get $output_block local.get $s11 v128.store offset=176
      local.get $output_block local.get $s12 v128.store offset=192
      local.get $output_block local.get $s13 v128.store offset=208
      local.get $output_block local.get $s14 v128.store offset=224
      local.get $output_block local.get $s15 v128.store offset=240

      local.get $block i32.const 1 i32.add local.set $block
      br $block_loop
    end end)
)
