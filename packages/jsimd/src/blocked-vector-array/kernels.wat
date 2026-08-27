(module
  (memory (export "memory") 1)

  ;; Each block contains 64 vectors in dimension-major order. Sixteen SIMD
  ;; accumulators keep every candidate independent across the dimension loop.
  (func $squared_distance_many (export "squared_distance_many")
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

  (func $clear_outputs (param $output i32) (param $count i32)
    local.get $output i32.const 0
    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u i32.const 8 i32.shl
    memory.fill)

  ;; Lower-register-pressure kernels accumulate through the output block. They
  ;; retain the same PDX64 input traversal while avoiding a second public layout.
  (func (export "l1_distance_many")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $output i32)
    (local $block i32) (local $blocks i32) (local $dimension i32) (local $group i32)
    (local $input i32) (local $output_block i32) (local $address i32)
    (local $query_lane v128)
    local.get $output local.get $count call $clear_outputs
    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u local.set $blocks
    block $done loop $block_loop
      local.get $block local.get $blocks i32.ge_u br_if $done
      local.get $output local.get $block i32.const 8 i32.shl i32.add local.set $output_block
      i32.const 0 local.set $dimension
      block $dimensions_done loop $dimension_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $dimensions_done
        local.get $vectors
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 8 i32.shl i32.add local.set $input
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add
        v128.load32_splat local.set $query_lane
        i32.const 0 local.set $group
        block $groups_done loop $group_loop
          local.get $group i32.const 16 i32.ge_u br_if $groups_done
          local.get $output_block local.get $group i32.const 4 i32.shl i32.add
          local.tee $address local.get $address v128.load
          local.get $input local.get $group i32.const 4 i32.shl i32.add v128.load
          local.get $query_lane f32x4.sub f32x4.abs f32x4.add v128.store
          local.get $group i32.const 1 i32.add local.set $group br $group_loop
        end end
        local.get $dimension i32.const 1 i32.add local.set $dimension br $dimension_loop
      end end
      local.get $block i32.const 1 i32.add local.set $block br $block_loop
    end end)

  (func $inner_product_many (export "inner_product_many")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $output i32)
    (local $block i32) (local $blocks i32) (local $dimension i32) (local $group i32)
    (local $input i32) (local $output_block i32) (local $address i32)
    (local $query_lane v128)
    local.get $output local.get $count call $clear_outputs
    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u local.set $blocks
    block $done loop $block_loop
      local.get $block local.get $blocks i32.ge_u br_if $done
      local.get $output local.get $block i32.const 8 i32.shl i32.add local.set $output_block
      i32.const 0 local.set $dimension
      block $dimensions_done loop $dimension_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $dimensions_done
        local.get $vectors
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 8 i32.shl i32.add local.set $input
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add
        v128.load32_splat local.set $query_lane
        i32.const 0 local.set $group
        block $groups_done loop $group_loop
          local.get $group i32.const 16 i32.ge_u br_if $groups_done
          local.get $output_block local.get $group i32.const 4 i32.shl i32.add
          local.tee $address local.get $address v128.load
          local.get $input local.get $group i32.const 4 i32.shl i32.add v128.load
          local.get $query_lane f32x4.mul f32x4.add v128.store
          local.get $group i32.const 1 i32.add local.set $group br $group_loop
        end end
        local.get $dimension i32.const 1 i32.add local.set $dimension br $dimension_loop
      end end
      local.get $block i32.const 1 i32.add local.set $block br $block_loop
    end end)

  (func $pair_greater
    (param $left_distance f32) (param $left_id i32)
    (param $right_distance f32) (param $right_id i32) (result i32)
    local.get $left_distance local.get $right_distance f32.gt
    if (result i32)
      i32.const 1
    else
      local.get $left_distance local.get $right_distance f32.eq
      if (result i32)
        local.get $left_id local.get $right_id i32.gt_u
      else
        i32.const 0
      end
    end)

  (func $swap_pair
    (param $ids i32) (param $distances i32) (param $left i32) (param $right i32)
    (local $left_id i32) (local $left_distance f32)
    local.get $ids local.get $left i32.const 2 i32.shl i32.add i32.load local.set $left_id
    local.get $distances local.get $left i32.const 2 i32.shl i32.add
    f32.load local.set $left_distance
    local.get $ids local.get $left i32.const 2 i32.shl i32.add
    local.get $ids local.get $right i32.const 2 i32.shl i32.add i32.load i32.store
    local.get $distances local.get $left i32.const 2 i32.shl i32.add
    local.get $distances local.get $right i32.const 2 i32.shl i32.add f32.load f32.store
    local.get $ids local.get $right i32.const 2 i32.shl i32.add local.get $left_id i32.store
    local.get $distances local.get $right i32.const 2 i32.shl i32.add
    local.get $left_distance f32.store)

  (func $sift_up
    (param $ids i32) (param $distances i32) (param $start i32)
    (local $child i32) (local $parent i32)
    local.get $start local.set $child
    block $done loop $loop
      local.get $child i32.eqz br_if $done
      local.get $child i32.const 1 i32.sub i32.const 1 i32.shr_u local.set $parent
      local.get $distances local.get $parent i32.const 2 i32.shl i32.add f32.load
      local.get $ids local.get $parent i32.const 2 i32.shl i32.add i32.load
      local.get $distances local.get $child i32.const 2 i32.shl i32.add f32.load
      local.get $ids local.get $child i32.const 2 i32.shl i32.add i32.load
      call $pair_greater br_if $done
      local.get $ids local.get $distances local.get $parent local.get $child call $swap_pair
      local.get $parent local.set $child
      br $loop
    end end)

  (func $sift_down
    (param $ids i32) (param $distances i32) (param $start i32) (param $size i32)
    (local $parent i32) (local $left i32) (local $right i32) (local $child i32)
    local.get $start local.set $parent
    block $done loop $loop
      local.get $parent i32.const 1 i32.shl i32.const 1 i32.add local.set $left
      local.get $left local.get $size i32.ge_u br_if $done
      local.get $left i32.const 1 i32.add local.set $right
      local.get $left local.set $child
      local.get $right local.get $size i32.lt_u
      if
        local.get $distances local.get $right i32.const 2 i32.shl i32.add f32.load
        local.get $ids local.get $right i32.const 2 i32.shl i32.add i32.load
        local.get $distances local.get $left i32.const 2 i32.shl i32.add f32.load
        local.get $ids local.get $left i32.const 2 i32.shl i32.add i32.load
        call $pair_greater
        if local.get $right local.set $child end
      end
      local.get $distances local.get $child i32.const 2 i32.shl i32.add f32.load
      local.get $ids local.get $child i32.const 2 i32.shl i32.add i32.load
      local.get $distances local.get $parent i32.const 2 i32.shl i32.add f32.load
      local.get $ids local.get $parent i32.const 2 i32.shl i32.add i32.load
      call $pair_greater i32.eqz br_if $done
      local.get $ids local.get $distances local.get $parent local.get $child call $swap_pair
      local.get $child local.set $parent
      br $loop
    end end)

  ;; Keeps a bounded max-heap, then heap-sorts selected (score, row-id) pairs.
  (func $select_top_k
    (param $scratch i32) (param $count i32)
    (param $output_ids i32) (param $output_distances i32) (param $k i32)
    (local $candidate i32) (local $candidate_distance f32)
    (local $filled i32) (local $heap_size i32)

    block $candidates_done loop $candidate_loop
      local.get $candidate local.get $count i32.ge_u br_if $candidates_done
      local.get $scratch local.get $candidate i32.const 2 i32.shl i32.add
      f32.load local.set $candidate_distance
      local.get $filled local.get $k i32.lt_u
      if
        local.get $output_ids local.get $filled i32.const 2 i32.shl i32.add
        local.get $candidate i32.store
        local.get $output_distances local.get $filled i32.const 2 i32.shl i32.add
        local.get $candidate_distance f32.store
        local.get $output_ids local.get $output_distances local.get $filled call $sift_up
        local.get $filled i32.const 1 i32.add local.set $filled
      else
        local.get $output_distances f32.load
        local.get $output_ids i32.load
        local.get $candidate_distance local.get $candidate
        call $pair_greater
        if
          local.get $output_ids local.get $candidate i32.store
          local.get $output_distances local.get $candidate_distance f32.store
          local.get $output_ids local.get $output_distances i32.const 0 local.get $k call $sift_down
        end
      end
      local.get $candidate i32.const 1 i32.add local.set $candidate
      br $candidate_loop
    end end

    local.get $k local.set $heap_size
    block $sort_done loop $sort_loop
      local.get $heap_size i32.const 1 i32.le_u br_if $sort_done
      local.get $heap_size i32.const 1 i32.sub local.set $heap_size
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $swap_pair
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $sift_down
      br $sort_loop
    end end)

  (func $negate_many (param $values i32) (param $count i32)
    (local $index i32) (local $end4 i32)
    local.get $count i32.const -4 i32.and local.set $end4
    block $vectors_done loop $vectors
      local.get $index local.get $end4 i32.ge_u br_if $vectors_done
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      v128.load f32x4.neg v128.store
      local.get $index i32.const 4 i32.add local.set $index br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $count i32.ge_u br_if $done
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      f32.load f32.neg f32.store
      local.get $index i32.const 1 i32.add local.set $index br $tail
    end end)

  (func (export "top_k")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $scratch i32)
    (param $output_ids i32) (param $output_distances i32) (param $k i32)
    local.get $vectors local.get $query local.get $count local.get $dimensions local.get $scratch
    call $squared_distance_many
    local.get $scratch local.get $count local.get $output_ids local.get $output_distances local.get $k
    call $select_top_k)

  ;; Negation maps descending products onto the same ascending score selector.
  (func (export "top_k_inner_product")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $scratch i32)
    (param $output_ids i32) (param $output_products i32) (param $k i32)
    local.get $vectors local.get $query local.get $count local.get $dimensions local.get $scratch
    call $inner_product_many
    local.get $scratch local.get $count call $negate_many
    local.get $scratch local.get $count local.get $output_ids local.get $output_products local.get $k
    call $select_top_k
    local.get $output_products local.get $k call $negate_many)
)
