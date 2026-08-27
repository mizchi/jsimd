(module
  (import "jsimd" "memory" (memory 1 65536 shared))

  ;; Writes one packed bit per value for minimum <= value < maximum. The caller
  ;; clears the padded mask before invoking this kernel.
  (func (export "scan_i32_between_mask")
    (param $values i32) (param $length i32)
    (param $minimum i32) (param $maximum i32) (param $mask i32)
    (local $index i32) (local $end4 i32) (local $bits i32)
    (local $address i32) (local $value i32) (local $lanes v128)

    local.get $length i32.const -4 i32.and local.set $end4
    block $simd_done loop $simd
      local.get $index local.get $end4 i32.ge_u br_if $simd_done
      local.get $values local.get $index i32.const 2 i32.shl i32.add
      v128.load align=4 local.tee $lanes
      local.get $minimum i32x4.splat i32x4.ge_s
      local.get $lanes local.get $maximum i32x4.splat i32x4.lt_s
      v128.and i32x4.bitmask
      local.get $index i32.const 31 i32.and i32.shl local.set $bits
      local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
      local.tee $address local.get $address i32.load local.get $bits i32.or i32.store
      local.get $index i32.const 4 i32.add local.set $index
      br $simd
    end end

    block $done loop $tail
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $values local.get $index i32.const 2 i32.shl i32.add i32.load
      local.tee $value local.get $minimum i32.ge_s
      local.get $value local.get $maximum i32.lt_s i32.and
      if
        local.get $mask local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
        local.tee $address local.get $address i32.load
        i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.or i32.store
      end
      local.get $index i32.const 1 i32.add local.set $index
      br $tail
    end end)

  ;; Computes PDX64 squared-L2 blocks only when their selection words are
  ;; non-empty, then finds top-1 by iterating set bits with ctz.
  (func $masked_squared_l2_top1_pdx64 (export "masked_squared_l2_top1_pdx64")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $mask i32) (param $scratch i32) (param $result i32)
    (local $block i32) (local $blocks i32) (local $dimension i32) (local $group i32)
    (local $input i32) (local $output_block i32) (local $address i32)
    (local $query_lane v128) (local $delta v128)
    (local $word_index i32) (local $word_count i32) (local $word i32)
    (local $bit i32) (local $row i32) (local $selected i32)
    (local $best_id i32) (local $best_distance f32) (local $distance f32)

    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u local.set $blocks
    local.get $scratch i32.const 0 local.get $blocks i32.const 8 i32.shl memory.fill

    block $blocks_done loop $block_loop
      local.get $block local.get $blocks i32.ge_u br_if $blocks_done
      local.get $mask local.get $block i32.const 3 i32.shl i32.add i32.load
      local.get $mask local.get $block i32.const 3 i32.shl i32.add i32.load offset=4
      i32.or i32.eqz
      if
        local.get $block i32.const 1 i32.add local.set $block
        br $block_loop
      end

      local.get $scratch local.get $block i32.const 8 i32.shl i32.add local.set $output_block
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
          local.get $query_lane f32x4.sub local.tee $delta local.get $delta f32x4.mul
          f32x4.add v128.store
          local.get $group i32.const 1 i32.add local.set $group
          br $group_loop
        end end
        local.get $dimension i32.const 1 i32.add local.set $dimension
        br $dimension_loop
      end end
      local.get $block i32.const 1 i32.add local.set $block
      br $block_loop
    end end

    i32.const -1 local.set $best_id
    f32.const inf local.set $best_distance
    local.get $count i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_count
    block $words_done loop $word_loop
      local.get $word_index local.get $word_count i32.ge_u br_if $words_done
      local.get $mask local.get $word_index i32.const 2 i32.shl i32.add i32.load local.set $word
      block $bits_done loop $bit_loop
        local.get $word i32.eqz br_if $bits_done
        local.get $word i32.ctz local.set $bit
        local.get $word_index i32.const 5 i32.shl local.get $bit i32.add local.set $row
        local.get $row local.get $count i32.lt_u
        if
          local.get $scratch local.get $row i32.const 2 i32.shl i32.add f32.load
          local.set $distance
          local.get $selected i32.const 1 i32.add local.set $selected
          local.get $distance local.get $best_distance f32.lt
          local.get $distance local.get $best_distance f32.eq
          local.get $row local.get $best_id i32.lt_u i32.and i32.or
          if
            local.get $row local.set $best_id
            local.get $distance local.set $best_distance
          end
        end
        local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
        br $bit_loop
      end end
      local.get $word_index i32.const 1 i32.add local.set $word_index
      br $word_loop
    end end

    local.get $result local.get $best_id i32.store
    local.get $result local.get $best_distance f32.store offset=4
    local.get $result local.get $selected i32.store offset=8)

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

  (func $select_masked_top_k (param $scratch i32) (param $count i32) (param $mask i32)
    (param $output_ids i32) (param $output_distances i32) (param $k i32) (result i32)
    (local $word_index i32) (local $word_count i32) (local $word i32)
    (local $bit i32) (local $candidate i32) (local $candidate_distance f32)
    (local $filled i32) (local $heap_size i32)

    local.get $k i32.eqz if i32.const 0 return end
    local.get $count i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_count
    block $words_done loop $word_loop
      local.get $word_index local.get $word_count i32.ge_u br_if $words_done
      local.get $mask local.get $word_index i32.const 2 i32.shl i32.add i32.load local.set $word
      block $bits_done loop $bit_loop
        local.get $word i32.eqz br_if $bits_done
        local.get $word i32.ctz local.set $bit
        local.get $word_index i32.const 5 i32.shl local.get $bit i32.add local.set $candidate
        local.get $candidate local.get $count i32.lt_u
        if
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
            local.get $candidate_distance local.get $candidate call $pair_greater
            if
              local.get $output_ids local.get $candidate i32.store
              local.get $output_distances local.get $candidate_distance f32.store
              local.get $output_ids local.get $output_distances i32.const 0 local.get $k call $sift_down
            end
          end
        end
        local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
        br $bit_loop
      end end
      local.get $word_index i32.const 1 i32.add local.set $word_index
      br $word_loop
    end end

    local.get $filled local.set $heap_size
    block $sort_done loop $sort_loop
      local.get $heap_size i32.const 1 i32.le_u br_if $sort_done
      local.get $heap_size i32.const 1 i32.sub local.set $heap_size
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $swap_pair
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $sift_down
      br $sort_loop
    end end
    local.get $filled)

  ;; Uses the top-1 path to produce the selected SIMD score buffer, then keeps
  ;; the bounded heap and sorted output entirely inside Wasm.
  (func (export "masked_squared_l2_topk_pdx64")
    (param $vectors i32) (param $query i32) (param $count i32)
    (param $dimensions i32) (param $mask i32) (param $scratch i32)
    (param $result i32) (param $output_ids i32) (param $output_distances i32)
    (param $k i32) (result i32)
    local.get $vectors local.get $query local.get $count local.get $dimensions
    local.get $mask local.get $scratch local.get $result
    call $masked_squared_l2_top1_pdx64
    local.get $scratch local.get $count local.get $mask local.get $output_ids
    local.get $output_distances local.get $k call $select_masked_top_k)

  ;; Uses per-PDX64-block axis-aligned bounds to skip complete vector blocks.
  ;; Each per-dimension term is no larger than the corresponding candidate
  ;; term, and is accumulated in the same Float32 dimension order as PDX.
  (func (export "masked_squared_l2_topk_pdx64_pruned")
    (param $vectors i32) (param $block_minimums i32) (param $block_maximums i32)
    (param $query i32) (param $count i32) (param $dimensions i32) (param $mask i32)
    (param $scratch i32) (param $output_ids i32) (param $output_distances i32)
    (param $k i32) (param $stats i32) (result i32)
    (local $block i32) (local $blocks i32) (local $dimension i32) (local $group i32)
    (local $input i32) (local $address i32) (local $word_index i32) (local $word i32)
    (local $bit i32) (local $row i32) (local $lane i32)
    (local $filled i32) (local $heap_size i32)
    (local $evaluated_blocks i32) (local $pruned_blocks i32) (local $evaluated_rows i32)
    (local $query_value f32) (local $minimum f32) (local $maximum f32)
    (local $delta_scalar f32) (local $term f32) (local $lower_bound f32)
    (local $candidate_distance f32) (local $query_lane v128) (local $delta v128)

    local.get $stats i32.const 0 i32.store
    local.get $stats i32.const 0 i32.store offset=4
    local.get $stats i32.const 0 i32.store offset=8
    local.get $k i32.eqz if i32.const 0 return end
    local.get $count i32.const 63 i32.add i32.const 6 i32.shr_u local.set $blocks

    block $blocks_done loop $block_loop
      local.get $block local.get $blocks i32.ge_u br_if $blocks_done
      local.get $mask local.get $block i32.const 3 i32.shl i32.add i32.load
      local.get $mask local.get $block i32.const 3 i32.shl i32.add i32.load offset=4
      i32.or i32.eqz
      if
        local.get $block i32.const 1 i32.add local.set $block
        br $block_loop
      end

      f32.const 0 local.set $lower_bound
      i32.const 0 local.set $dimension
      block $bounds_done loop $bounds_loop
        local.get $dimension local.get $dimensions i32.ge_u br_if $bounds_done
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add
        f32.load local.set $query_value
        local.get $block_minimums
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 2 i32.shl i32.add f32.load local.set $minimum
        local.get $block_maximums
        local.get $block local.get $dimensions i32.mul local.get $dimension i32.add
        i32.const 2 i32.shl i32.add f32.load local.set $maximum
        f32.const 0 local.set $delta_scalar
        local.get $query_value local.get $minimum f32.lt
        if
          local.get $minimum local.get $query_value f32.sub local.set $delta_scalar
        else
          local.get $query_value local.get $maximum f32.gt
          if
            local.get $query_value local.get $maximum f32.sub local.set $delta_scalar
          end
        end
        local.get $delta_scalar local.get $delta_scalar f32.mul local.set $term
        local.get $lower_bound local.get $term f32.add local.set $lower_bound
        local.get $dimension i32.const 1 i32.add local.set $dimension
        br $bounds_loop
      end end

      local.get $filled local.get $k i32.ge_u
      if
        local.get $lower_bound local.get $output_distances f32.load f32.gt
        if
          local.get $pruned_blocks i32.const 1 i32.add local.set $pruned_blocks
          local.get $block i32.const 1 i32.add local.set $block
          br $block_loop
        end
      end

      local.get $evaluated_blocks i32.const 1 i32.add local.set $evaluated_blocks
      local.get $scratch i32.const 0 i32.const 256 memory.fill
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
          local.get $scratch local.get $group i32.const 4 i32.shl i32.add
          local.tee $address local.get $address v128.load
          local.get $input local.get $group i32.const 4 i32.shl i32.add v128.load
          local.get $query_lane f32x4.sub local.tee $delta local.get $delta f32x4.mul
          f32x4.add v128.store
          local.get $group i32.const 1 i32.add local.set $group
          br $group_loop
        end end
        local.get $dimension i32.const 1 i32.add local.set $dimension
        br $dimension_loop
      end end

      i32.const 0 local.set $word_index
      block $words_done loop $word_loop
        local.get $word_index i32.const 2 i32.ge_u br_if $words_done
        local.get $mask local.get $block i32.const 3 i32.shl i32.add
        local.get $word_index i32.const 2 i32.shl i32.add i32.load local.set $word
        block $bits_done loop $bit_loop
          local.get $word i32.eqz br_if $bits_done
          local.get $word i32.ctz local.set $bit
          local.get $word_index i32.const 5 i32.shl local.get $bit i32.add local.set $lane
          local.get $block i32.const 6 i32.shl local.get $lane i32.add local.set $row
          local.get $row local.get $count i32.lt_u
          if
            local.get $scratch local.get $lane i32.const 2 i32.shl i32.add
            f32.load local.set $candidate_distance
            local.get $evaluated_rows i32.const 1 i32.add local.set $evaluated_rows
            local.get $filled local.get $k i32.lt_u
            if
              local.get $output_ids local.get $filled i32.const 2 i32.shl i32.add
              local.get $row i32.store
              local.get $output_distances local.get $filled i32.const 2 i32.shl i32.add
              local.get $candidate_distance f32.store
              local.get $output_ids local.get $output_distances local.get $filled call $sift_up
              local.get $filled i32.const 1 i32.add local.set $filled
            else
              local.get $output_distances f32.load local.get $output_ids i32.load
              local.get $candidate_distance local.get $row call $pair_greater
              if
                local.get $output_ids local.get $row i32.store
                local.get $output_distances local.get $candidate_distance f32.store
                local.get $output_ids local.get $output_distances i32.const 0 local.get $k
                call $sift_down
              end
            end
          end
          local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
          br $bit_loop
        end end
        local.get $word_index i32.const 1 i32.add local.set $word_index
        br $word_loop
      end end
      local.get $block i32.const 1 i32.add local.set $block
      br $block_loop
    end end

    local.get $filled local.set $heap_size
    block $sort_done loop $sort_loop
      local.get $heap_size i32.const 1 i32.le_u br_if $sort_done
      local.get $heap_size i32.const 1 i32.sub local.set $heap_size
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $swap_pair
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $sift_down
      br $sort_loop
    end end
    local.get $stats local.get $evaluated_blocks i32.store
    local.get $stats local.get $pruned_blocks i32.store offset=4
    local.get $stats local.get $evaluated_rows i32.store offset=8
    local.get $filled)

  ;; Finds the nearest selected fixed-width binary signature. Signature stride
  ;; is padded to 16 bytes so XOR + popcnt never requires a scalar tail.
  (func (export "masked_hamming_top1")
    (param $signatures i32) (param $query i32) (param $count i32)
    (param $stride i32) (param $mask i32) (param $result i32)
    (local $word_index i32) (local $word_count i32) (local $word i32)
    (local $bit i32) (local $row i32) (local $selected i32)
    (local $offset i32) (local $distance i32) (local $sums v128)
    (local $best_id i32) (local $best_distance i32)

    i32.const -1 local.set $best_id
    i32.const -1 local.set $best_distance
    local.get $count i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_count
    block $words_done loop $word_loop
      local.get $word_index local.get $word_count i32.ge_u br_if $words_done
      local.get $mask local.get $word_index i32.const 2 i32.shl i32.add i32.load local.set $word
      block $bits_done loop $bit_loop
        local.get $word i32.eqz br_if $bits_done
        local.get $word i32.ctz local.set $bit
        local.get $word_index i32.const 5 i32.shl local.get $bit i32.add local.set $row
        local.get $row local.get $count i32.lt_u
        if
          i32.const 0 local.set $offset
          i32.const 0 local.set $distance
          block $signature_done loop $signature_loop
            local.get $offset local.get $stride i32.ge_u br_if $signature_done
            local.get $signatures local.get $row local.get $stride i32.mul i32.add
            local.get $offset i32.add v128.load
            local.get $query local.get $offset i32.add v128.load
            v128.xor i8x16.popcnt
            i16x8.extadd_pairwise_i8x16_u
            i32x4.extadd_pairwise_i16x8_u local.set $sums
            local.get $distance
            local.get $sums i32x4.extract_lane 0 i32.add
            local.get $sums i32x4.extract_lane 1 i32.add
            local.get $sums i32x4.extract_lane 2 i32.add
            local.get $sums i32x4.extract_lane 3 i32.add local.set $distance
            local.get $offset i32.const 16 i32.add local.set $offset
            br $signature_loop
          end end
          local.get $selected i32.const 1 i32.add local.set $selected
          local.get $distance local.get $best_distance i32.lt_u
          local.get $distance local.get $best_distance i32.eq
          local.get $row local.get $best_id i32.lt_u i32.and i32.or
          if
            local.get $row local.set $best_id
            local.get $distance local.set $best_distance
          end
        end
        local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
        br $bit_loop
      end end
      local.get $word_index i32.const 1 i32.add local.set $word_index
      br $word_loop
    end end

    local.get $result local.get $best_id i32.store
    local.get $result local.get $best_distance i32.store offset=4
    local.get $result local.get $selected i32.store offset=8)

  (func $pair_greater_u32
    (param $left_distance i32) (param $left_id i32)
    (param $right_distance i32) (param $right_id i32) (result i32)
    local.get $left_distance local.get $right_distance i32.gt_u
    if (result i32)
      i32.const 1
    else
      local.get $left_distance local.get $right_distance i32.eq
      if (result i32)
        local.get $left_id local.get $right_id i32.gt_u
      else
        i32.const 0
      end
    end)

  (func $swap_pair_u32
    (param $ids i32) (param $distances i32) (param $left i32) (param $right i32)
    (local $left_id i32) (local $left_distance i32)
    local.get $ids local.get $left i32.const 2 i32.shl i32.add i32.load local.set $left_id
    local.get $distances local.get $left i32.const 2 i32.shl i32.add
    i32.load local.set $left_distance
    local.get $ids local.get $left i32.const 2 i32.shl i32.add
    local.get $ids local.get $right i32.const 2 i32.shl i32.add i32.load i32.store
    local.get $distances local.get $left i32.const 2 i32.shl i32.add
    local.get $distances local.get $right i32.const 2 i32.shl i32.add i32.load i32.store
    local.get $ids local.get $right i32.const 2 i32.shl i32.add local.get $left_id i32.store
    local.get $distances local.get $right i32.const 2 i32.shl i32.add
    local.get $left_distance i32.store)

  (func $sift_up_u32
    (param $ids i32) (param $distances i32) (param $start i32)
    (local $child i32) (local $parent i32)
    local.get $start local.set $child
    block $done loop $loop
      local.get $child i32.eqz br_if $done
      local.get $child i32.const 1 i32.sub i32.const 1 i32.shr_u local.set $parent
      local.get $distances local.get $parent i32.const 2 i32.shl i32.add i32.load
      local.get $ids local.get $parent i32.const 2 i32.shl i32.add i32.load
      local.get $distances local.get $child i32.const 2 i32.shl i32.add i32.load
      local.get $ids local.get $child i32.const 2 i32.shl i32.add i32.load
      call $pair_greater_u32 br_if $done
      local.get $ids local.get $distances local.get $parent local.get $child call $swap_pair_u32
      local.get $parent local.set $child
      br $loop
    end end)

  (func $sift_down_u32
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
        local.get $distances local.get $right i32.const 2 i32.shl i32.add i32.load
        local.get $ids local.get $right i32.const 2 i32.shl i32.add i32.load
        local.get $distances local.get $left i32.const 2 i32.shl i32.add i32.load
        local.get $ids local.get $left i32.const 2 i32.shl i32.add i32.load
        call $pair_greater_u32
        if local.get $right local.set $child end
      end
      local.get $distances local.get $child i32.const 2 i32.shl i32.add i32.load
      local.get $ids local.get $child i32.const 2 i32.shl i32.add i32.load
      local.get $distances local.get $parent i32.const 2 i32.shl i32.add i32.load
      local.get $ids local.get $parent i32.const 2 i32.shl i32.add i32.load
      call $pair_greater_u32 i32.eqz br_if $done
      local.get $ids local.get $distances local.get $parent local.get $child call $swap_pair_u32
      local.get $child local.set $parent
      br $loop
    end end)

  ;; Keeps the nearest selected binary signatures in Hamming order.
  (func (export "masked_hamming_topk")
    (param $signatures i32) (param $query i32) (param $count i32) (param $stride i32)
    (param $mask i32) (param $result i32) (param $output_ids i32)
    (param $output_distances i32) (param $k i32) (result i32)
    (local $word_index i32) (local $word_count i32) (local $word i32)
    (local $bit i32) (local $row i32) (local $selected i32)
    (local $offset i32) (local $distance i32) (local $sums v128)
    (local $filled i32) (local $heap_size i32)

    local.get $k i32.eqz if i32.const 0 return end
    local.get $count i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_count
    block $words_done loop $word_loop
      local.get $word_index local.get $word_count i32.ge_u br_if $words_done
      local.get $mask local.get $word_index i32.const 2 i32.shl i32.add i32.load local.set $word
      block $bits_done loop $bit_loop
        local.get $word i32.eqz br_if $bits_done
        local.get $word i32.ctz local.set $bit
        local.get $word_index i32.const 5 i32.shl local.get $bit i32.add local.set $row
        local.get $row local.get $count i32.lt_u
        if
          i32.const 0 local.set $offset
          i32.const 0 local.set $distance
          block $signature_done loop $signature_loop
            local.get $offset local.get $stride i32.ge_u br_if $signature_done
            local.get $signatures local.get $row local.get $stride i32.mul i32.add
            local.get $offset i32.add v128.load
            local.get $query local.get $offset i32.add v128.load
            v128.xor i8x16.popcnt
            i16x8.extadd_pairwise_i8x16_u
            i32x4.extadd_pairwise_i16x8_u local.set $sums
            local.get $distance
            local.get $sums i32x4.extract_lane 0 i32.add
            local.get $sums i32x4.extract_lane 1 i32.add
            local.get $sums i32x4.extract_lane 2 i32.add
            local.get $sums i32x4.extract_lane 3 i32.add local.set $distance
            local.get $offset i32.const 16 i32.add local.set $offset
            br $signature_loop
          end end
          local.get $selected i32.const 1 i32.add local.set $selected
          local.get $filled local.get $k i32.lt_u
          if
            local.get $output_ids local.get $filled i32.const 2 i32.shl i32.add local.get $row i32.store
            local.get $output_distances local.get $filled i32.const 2 i32.shl i32.add
            local.get $distance i32.store
            local.get $output_ids local.get $output_distances local.get $filled call $sift_up_u32
            local.get $filled i32.const 1 i32.add local.set $filled
          else
            local.get $output_distances i32.load local.get $output_ids i32.load
            local.get $distance local.get $row call $pair_greater_u32
            if
              local.get $output_ids local.get $row i32.store
              local.get $output_distances local.get $distance i32.store
              local.get $output_ids local.get $output_distances i32.const 0 local.get $k
              call $sift_down_u32
            end
          end
        end
        local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
        br $bit_loop
      end end
      local.get $word_index i32.const 1 i32.add local.set $word_index
      br $word_loop
    end end

    local.get $filled local.set $heap_size
    block $sort_done loop $sort_loop
      local.get $heap_size i32.const 1 i32.le_u br_if $sort_done
      local.get $heap_size i32.const 1 i32.sub local.set $heap_size
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $swap_pair_u32
      local.get $output_ids local.get $output_distances i32.const 0 local.get $heap_size
      call $sift_down_u32
      br $sort_loop
    end end
    local.get $result local.get $selected i32.store offset=8
    local.get $filled)

  (func $pdx64_lane
    (param $vectors i32) (param $dimensions i32) (param $id i32) (param $dimension i32)
    (result f32)
    local.get $vectors
    local.get $id i32.const 6 i32.shr_u local.get $dimensions i32.mul
    local.get $dimension i32.add i32.const 8 i32.shl i32.add
    local.get $id i32.const 63 i32.and i32.const 2 i32.shl i32.add
    f32.load)

  ;; Reranks sparse local IDs against the resident PDX64 Float32 vectors.
  (func (export "pdx64_squared_l2_selected")
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
          local.get $dimension call $pdx64_lane f32x4.replace_lane 0 local.set $candidates
        end
        local.get $group i32.const 1 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx64_lane f32x4.replace_lane 1 local.set $candidates
        end
        local.get $group i32.const 2 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx64_lane f32x4.replace_lane 2 local.set $candidates
        end
        local.get $group i32.const 3 i32.add local.set $index
        local.get $index local.get $count i32.lt_u if
          local.get $candidates local.get $vectors local.get $dimensions
          local.get $ids local.get $index i32.const 2 i32.shl i32.add i32.load
          local.get $dimension call $pdx64_lane f32x4.replace_lane 3 local.set $candidates
        end
        local.get $candidates
        local.get $query local.get $dimension i32.const 2 i32.shl i32.add v128.load32_splat
        f32x4.sub local.tee $delta local.get $delta f32x4.mul
        local.get $sum f32x4.add local.set $sum
        local.get $dimension i32.const 1 i32.add local.set $dimension
        br $dimensions_loop
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
      local.get $group i32.const 4 i32.add local.set $group
      br $groups_loop
    end end)
)
