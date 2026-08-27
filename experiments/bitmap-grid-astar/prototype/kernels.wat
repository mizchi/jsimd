(module
  (memory (export "memory") 1)

  (func $less
    (param $left_priority i32) (param $left_id i32)
    (param $right_priority i32) (param $right_id i32) (result i32)
    local.get $left_priority local.get $right_priority i32.lt_u
  )

  (func $heap_push
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $id i32) (param $priority i32) (result i32)
    (local $cursor i32) (local $parent i32)
    (local $parent_priority i32) (local $parent_id i32)
    local.get $size local.set $cursor
    block $placed
      loop $up
        local.get $cursor i32.eqz br_if $placed
        local.get $cursor i32.const 1 i32.sub i32.const 2 i32.shr_u local.set $parent
        local.get $priorities local.get $parent i32.const 2 i32.shl i32.add
        i32.load local.set $parent_priority
        local.get $ids local.get $parent i32.const 2 i32.shl i32.add
        i32.load local.set $parent_id
        local.get $priority local.get $id
        local.get $parent_priority local.get $parent_id call $less i32.eqz br_if $placed
        local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
        local.get $parent_priority i32.store
        local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
        local.get $parent_id i32.store
        local.get $parent local.set $cursor
        br $up
      end
    end
    local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
    local.get $priority i32.store
    local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
    local.get $id i32.store
    local.get $size i32.const 1 i32.add
  )

  (func $best_child_scalar
    (param $priorities i32) (param $ids i32) (param $first i32) (param $available i32)
    (result i32)
    (local $lane i32) (local $candidate i32) (local $best i32)
    (local $candidate_priority i32) (local $candidate_id i32)
    (local $best_priority i32) (local $best_id i32)
    local.get $first local.set $best
    local.get $priorities local.get $first i32.const 2 i32.shl i32.add
    i32.load local.set $best_priority
    local.get $ids local.get $first i32.const 2 i32.shl i32.add
    i32.load local.set $best_id
    i32.const 1 local.set $lane
    block $done
      loop $loop
        local.get $lane local.get $available i32.ge_u br_if $done
        local.get $first local.get $lane i32.add local.set $candidate
        local.get $priorities local.get $candidate i32.const 2 i32.shl i32.add
        i32.load local.set $candidate_priority
        local.get $ids local.get $candidate i32.const 2 i32.shl i32.add
        i32.load local.set $candidate_id
        local.get $candidate_priority local.get $candidate_id
        local.get $best_priority local.get $best_id call $less
        if
          local.get $candidate local.set $best
          local.get $candidate_priority local.set $best_priority
          local.get $candidate_id local.set $best_id
        end
        local.get $lane i32.const 1 i32.add local.set $lane
        br $loop
      end
    end
    local.get $best
  )

  (func $best_child_simd
    (param $priorities i32) (param $ids i32) (param $first i32) (result i32)
    (local $children v128) (local $pair_min v128) (local $minimum i32)
    (local $mask i32)
    local.get $priorities local.get $first i32.const 2 i32.shl i32.add
    v128.load local.set $children
    local.get $children
    local.get $children local.get $children
    i8x16.shuffle 4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11
    i32x4.min_u local.set $pair_min
    local.get $pair_min i32x4.extract_lane 0
    local.get $pair_min i32x4.extract_lane 2 i32.lt_u
    if
      local.get $pair_min i32x4.extract_lane 0 local.set $minimum
    else
      local.get $pair_min i32x4.extract_lane 2 local.set $minimum
    end
    local.get $children local.get $minimum i32x4.splat i32x4.eq i32x4.bitmask local.set $mask
    local.get $first local.get $mask i32.ctz i32.add
  )

  (func $heap_pop
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $output_id i32) (param $output_priority i32) (param $simd i32) (result i32)
    (local $next_size i32) (local $cursor i32) (local $first i32)
    (local $available i32) (local $child i32)
    (local $moving_priority i32) (local $moving_id i32)
    (local $child_priority i32) (local $child_id i32)
    local.get $output_id local.get $ids i32.load i32.store
    local.get $output_priority local.get $priorities i32.load i32.store
    local.get $size i32.const 1 i32.sub local.tee $next_size i32.eqz
    if local.get $next_size return end
    local.get $priorities local.get $next_size i32.const 2 i32.shl i32.add
    i32.load local.set $moving_priority
    local.get $ids local.get $next_size i32.const 2 i32.shl i32.add
    i32.load local.set $moving_id
    block $placed
      loop $down
        local.get $cursor i32.const 2 i32.shl i32.const 1 i32.add local.tee $first
        local.get $next_size i32.ge_u br_if $placed
        local.get $next_size local.get $first i32.sub local.set $available
        local.get $available i32.const 4 i32.gt_u
        if i32.const 4 local.set $available end
        local.get $simd local.get $available i32.const 4 i32.eq i32.and
        if
          local.get $priorities local.get $ids local.get $first call $best_child_simd
          local.set $child
        else
          local.get $priorities local.get $ids local.get $first local.get $available
          call $best_child_scalar local.set $child
        end
        local.get $priorities local.get $child i32.const 2 i32.shl i32.add
        i32.load local.set $child_priority
        local.get $ids local.get $child i32.const 2 i32.shl i32.add
        i32.load local.set $child_id
        local.get $child_priority local.get $child_id
        local.get $moving_priority local.get $moving_id call $less i32.eqz br_if $placed
        local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
        local.get $child_priority i32.store
        local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
        local.get $child_id i32.store
        local.get $child local.set $cursor
        br $down
      end
    end
    local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
    local.get $moving_priority i32.store
    local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
    local.get $moving_id i32.store
    local.get $next_size
  )

  (func $heuristic (param $node i32) (param $target i32) (param $width i32) (result i32)
    (local $x i32) (local $y i32) (local $target_x i32) (local $target_y i32)
    local.get $node local.get $width i32.rem_u local.set $x
    local.get $node local.get $width i32.div_u local.set $y
    local.get $target local.get $width i32.rem_u local.set $target_x
    local.get $target local.get $width i32.div_u local.set $target_y
    local.get $x local.get $target_x i32.gt_u
    if (result i32)
      local.get $x local.get $target_x i32.sub
    else
      local.get $target_x local.get $x i32.sub
    end
    local.get $y local.get $target_y i32.gt_u
    if (result i32)
      local.get $y local.get $target_y i32.sub
    else
      local.get $target_y local.get $y i32.sub
    end
    i32.add
  )

  (func $priority
    (param $distance i32) (param $node i32) (param $target i32)
    (param $width i32) (param $tie_scale i32) (result i32)
    (local $heuristic i32)
    local.get $node local.get $target local.get $width call $heuristic local.set $heuristic
    local.get $distance local.get $heuristic i32.add local.get $tie_scale i32.mul
    local.get $heuristic i32.add
  )

  (func $relax
    (param $walls i32) (param $neighbor i32) (param $node i32) (param $distance i32)
    (param $target i32) (param $width i32) (param $tie_scale i32)
    (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32) (param $heap_size i32)
    (result i32)
    (local $next_distance i32) (local $stored i32) (local $priority i32)
    local.get $walls local.get $neighbor i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
    i32.load
    i32.const 1 local.get $neighbor i32.const 31 i32.and i32.shl i32.and
    if local.get $heap_size return end
    local.get $distance i32.const 1 i32.add local.set $next_distance
    local.get $distances local.get $neighbor i32.const 2 i32.shl i32.add i32.load local.set $stored
    local.get $stored i32.const -1 i32.ne
    if
      local.get $next_distance local.get $stored i32.ge_u
      if local.get $heap_size return end
    end
    local.get $distances local.get $neighbor i32.const 2 i32.shl i32.add
    local.get $next_distance i32.store
    local.get $previous local.get $neighbor i32.const 2 i32.shl i32.add
    local.get $node i32.store
    local.get $next_distance local.get $neighbor local.get $target
    local.get $width local.get $tie_scale call $priority local.set $priority
    local.get $heap_priorities local.get $heap_ids local.get $heap_size
    local.get $neighbor local.get $priority call $heap_push
  )

  (func $astar
    (param $walls i32) (param $width i32) (param $height i32)
    (param $start i32) (param $target i32)
    (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (param $simd i32) (result i32)
    (local $node_count i32) (local $tie_scale i32) (local $index i32)
    (local $heap_size i32) (local $node i32) (local $x i32)
    (local $distance i32) (local $expected_priority i32)
    local.get $width local.get $height i32.mul local.set $node_count
    local.get $width local.get $height i32.add local.set $tie_scale
    block $initialized
      loop $initialize
        local.get $index local.get $node_count i32.ge_u br_if $initialized
        local.get $distances local.get $index i32.const 2 i32.shl i32.add
        i32.const -1 i32.store
        local.get $previous local.get $index i32.const 2 i32.shl i32.add
        i32.const -1 i32.store
        local.get $index i32.const 1 i32.add local.set $index
        br $initialize
      end
    end
    local.get $distances local.get $start i32.const 2 i32.shl i32.add i32.const 0 i32.store
    local.get $heap_priorities local.get $heap_ids i32.const 0 local.get $start
    i32.const 0 local.get $start local.get $target local.get $width local.get $tie_scale
    call $priority call $heap_push local.set $heap_size
    block $done
      loop $search
        local.get $heap_size i32.eqz br_if $done
        local.get $heap_priorities local.get $heap_ids local.get $heap_size
        local.get $output_id local.get $output_priority local.get $simd
        call $heap_pop local.set $heap_size
        local.get $output_id i32.load local.set $node
        local.get $distances local.get $node i32.const 2 i32.shl i32.add i32.load local.set $distance
        local.get $distance i32.const -1 i32.eq
        if br $search end
        local.get $distance local.get $node local.get $target
        local.get $width local.get $tie_scale call $priority local.set $expected_priority
        local.get $output_priority i32.load local.get $expected_priority i32.ne
        if br $search end
        local.get $node local.get $target i32.eq br_if $done
        local.get $node local.get $width i32.rem_u local.set $x
        local.get $x i32.eqz
        if
        else
          local.get $walls local.get $node i32.const 1 i32.sub local.get $node local.get $distance
          local.get $target local.get $width local.get $tie_scale local.get $distances local.get $previous
          local.get $heap_priorities local.get $heap_ids local.get $heap_size call $relax local.set $heap_size
        end
        local.get $x i32.const 1 i32.add local.get $width i32.lt_u
        if
          local.get $walls local.get $node i32.const 1 i32.add local.get $node local.get $distance
          local.get $target local.get $width local.get $tie_scale local.get $distances local.get $previous
          local.get $heap_priorities local.get $heap_ids local.get $heap_size call $relax local.set $heap_size
        end
        local.get $node local.get $width i32.ge_u
        if
          local.get $walls local.get $node local.get $width i32.sub local.get $node local.get $distance
          local.get $target local.get $width local.get $tie_scale local.get $distances local.get $previous
          local.get $heap_priorities local.get $heap_ids local.get $heap_size call $relax local.set $heap_size
        end
        local.get $node local.get $width i32.add local.get $node_count i32.lt_u
        if
          local.get $walls local.get $node local.get $width i32.add local.get $node local.get $distance
          local.get $target local.get $width local.get $tie_scale local.get $distances local.get $previous
          local.get $heap_priorities local.get $heap_ids local.get $heap_size call $relax local.set $heap_size
        end
        br $search
      end
    end
    local.get $distances local.get $target i32.const 2 i32.shl i32.add i32.load
  )

  (func (export "astar_simd")
    (param $walls i32) (param $width i32) (param $height i32)
    (param $start i32) (param $target i32) (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (result i32)
    local.get $walls local.get $width local.get $height local.get $start local.get $target
    local.get $distances local.get $previous local.get $heap_priorities local.get $heap_ids
    local.get $output_id local.get $output_priority i32.const 1 call $astar
  )

  (func (export "astar_scalar")
    (param $walls i32) (param $width i32) (param $height i32)
    (param $start i32) (param $target i32) (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (result i32)
    local.get $walls local.get $width local.get $height local.get $start local.get $target
    local.get $distances local.get $previous local.get $heap_priorities local.get $heap_ids
    local.get $output_id local.get $output_priority i32.const 0 call $astar
  )
)
