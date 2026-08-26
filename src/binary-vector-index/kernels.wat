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

  ;; PDX stores four vectors per block in dimension-major order.
  (func (export "pdx_distance_many")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $output i32)
    (local $block i32) (local $blocks i32) (local $dimension i32)
    (local $values v128) (local $delta v128) (local $sum v128)
    local.get $count i32.const 3 i32.add i32.const 2 i32.shr_u local.set $blocks
    block $done loop $blocks_loop
      local.get $block local.get $blocks i32.ge_u br_if $done
      v128.const i32x4 0 0 0 0 local.set $sum
      i32.const 0 local.set $dimension
      block $dimensions_done loop $dimensions_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $dimensions_done
        local.get $vectors
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 4 i32.shl i32.add v128.load local.set $values
        local.get $values
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add v128.load32_splat
        f32x4.sub local.tee $delta
        local.get $delta f32x4.mul
        local.get $sum f32x4.add local.set $sum
        local.get $dimension i32.const 1 i32.add local.set $dimension br $dimensions_loop
      end end
      local.get $output local.get $block i32.const 4 i32.shl i32.add local.get $sum v128.store
      local.get $block i32.const 1 i32.add local.set $block br $blocks_loop
    end end)

  (func $pdx_lane
    (param $vectors i32) (param $dimensions i32) (param $id i32) (param $dimension i32)
    (result f32)
    local.get $vectors
    local.get $id i32.const 2 i32.shr_u local.get $dimensions i32.mul
    local.get $dimension i32.add i32.const 4 i32.shl i32.add
    local.get $id i32.const 3 i32.and i32.const 2 i32.shl i32.add
    f32.load)

  (func (export "pdx_distance_selected")
    (param $vectors i32) (param $query i32) (param $ids i32)
    (param $count i32) (param $dimensions i32) (param $output i32)
    (local $group i32) (local $dimension i32) (local $index i32)
    (local $candidates v128) (local $delta v128) (local $sum v128)
    block $done loop $groups_loop
      local.get $group local.get $count i32.ge_u br_if $done
      v128.const i32x4 0 0 0 0 local.set $sum
      i32.const 0 local.set $dimension
      block $dimensions_done loop $dimensions_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $dimensions_done
        v128.const i32x4 0 0 0 0 local.set $candidates
        local.get $group local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx_lane f32x4.replace_lane 0 local.set $candidates
        end
        local.get $group i32.const 1 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx_lane f32x4.replace_lane 1 local.set $candidates
        end
        local.get $group i32.const 2 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx_lane f32x4.replace_lane 2 local.set $candidates
        end
        local.get $group i32.const 3 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx_lane f32x4.replace_lane 3 local.set $candidates
        end
        local.get $candidates
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add v128.load32_splat
        f32x4.sub local.tee $delta
        local.get $delta f32x4.mul
        local.get $sum f32x4.add local.set $sum
        local.get $dimension i32.const 1 i32.add local.set $dimension br $dimensions_loop
      end end
      local.get $output local.get $group i32.const 2 i32.shl i32.add
      local.get $sum f32x4.extract_lane 0 f32.store
      local.get $group i32.const 1 i32.add local.tee $index local.get $count i32.lt_u if
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $sum f32x4.extract_lane 1 f32.store
      end
      local.get $group i32.const 2 i32.add local.tee $index local.get $count i32.lt_u if
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $sum f32x4.extract_lane 2 f32.store
      end
      local.get $group i32.const 3 i32.add local.tee $index local.get $count i32.lt_u if
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $sum f32x4.extract_lane 3 f32.store
      end
      local.get $group i32.const 4 i32.add local.set $group br $groups_loop
    end end)
)
