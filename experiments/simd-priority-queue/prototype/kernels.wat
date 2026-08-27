(module
  (memory (export "memory") 1)

  (func $less
    (param $left_priority f32) (param $left_id i32)
    (param $right_priority f32) (param $right_id i32)
    (result i32)
    local.get $left_priority local.get $right_priority f32.lt
    if (result i32)
      i32.const 1
    else
      local.get $left_priority local.get $right_priority f32.eq
      if (result i32)
        local.get $left_id local.get $right_id i32.lt_u
      else
        i32.const 0
      end
    end
  )

  (func $heap_push
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $id i32) (param $priority f32)
    (result i32)
    (local $cursor i32) (local $parent i32)
    (local $parent_priority f32) (local $parent_id i32)
    local.get $size local.set $cursor
    block $placed
      loop $up
        local.get $cursor i32.eqz br_if $placed
        local.get $cursor i32.const 1 i32.sub i32.const 2 i32.shr_u local.set $parent
        local.get $priorities local.get $parent i32.const 2 i32.shl i32.add
        f32.load local.set $parent_priority
        local.get $ids local.get $parent i32.const 2 i32.shl i32.add
        i32.load local.set $parent_id
        local.get $priority local.get $id
        local.get $parent_priority local.get $parent_id call $less i32.eqz br_if $placed
        local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
        local.get $parent_priority f32.store
        local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
        local.get $parent_id i32.store
        local.get $parent local.set $cursor
        br $up
      end
    end
    local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
    local.get $priority f32.store
    local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
    local.get $id i32.store
    local.get $size i32.const 1 i32.add
  )

  (func (export "push")
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $id i32) (param $priority f32)
    (result i32)
    local.get $priorities local.get $ids local.get $size local.get $id local.get $priority
    call $heap_push
  )

  (func (export "push_many")
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $input_ids i32) (param $input_priorities i32) (param $count i32)
    (result i32)
    (local $index i32)
    block $done
      loop $loop
        local.get $index local.get $count i32.ge_u br_if $done
        local.get $priorities local.get $ids local.get $size
        local.get $input_ids local.get $index i32.const 2 i32.shl i32.add i32.load
        local.get $input_priorities local.get $index i32.const 2 i32.shl i32.add f32.load
        call $heap_push local.set $size
        local.get $index i32.const 1 i32.add local.set $index
        br $loop
      end
    end
    local.get $size
  )

  (func $best_child_scalar
    (param $priorities i32) (param $ids i32) (param $first i32) (param $available i32)
    (result i32)
    (local $lane i32) (local $candidate i32) (local $best i32)
    (local $candidate_priority f32) (local $candidate_id i32)
    (local $best_priority f32) (local $best_id i32)
    local.get $first local.set $best
    local.get $priorities local.get $first i32.const 2 i32.shl i32.add
    f32.load local.set $best_priority
    local.get $ids local.get $first i32.const 2 i32.shl i32.add
    i32.load local.set $best_id
    i32.const 1 local.set $lane
    block $done
      loop $loop
        local.get $lane local.get $available i32.ge_u br_if $done
        local.get $first local.get $lane i32.add local.set $candidate
        local.get $priorities local.get $candidate i32.const 2 i32.shl i32.add
        f32.load local.set $candidate_priority
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

  ;; Full four-child groups use one v128 load and a horizontal f32 minimum. Equal-priority lanes
  ;; are resolved by unsigned ID so the public queue has deterministic ordering.
  (func $best_child_simd
    (param $priorities i32) (param $ids i32) (param $first i32)
    (result i32)
    (local $children v128) (local $pair_min v128) (local $minimum f32)
    (local $mask i32) (local $lane i32) (local $candidate_id i32)
    (local $best_lane i32) (local $best_id i32)
    local.get $priorities local.get $first i32.const 2 i32.shl i32.add
    v128.load local.set $children
    local.get $children
    local.get $children local.get $children
    i8x16.shuffle 4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11
    f32x4.min local.set $pair_min
    local.get $pair_min f32x4.extract_lane 0
    local.get $pair_min f32x4.extract_lane 2
    f32.min local.set $minimum
    local.get $children local.get $minimum f32x4.splat f32x4.eq i32x4.bitmask local.set $mask
    local.get $mask i32.ctz local.set $best_lane
    local.get $ids local.get $first local.get $best_lane i32.add i32.const 2 i32.shl i32.add
    i32.load local.set $best_id
    local.get $mask i32.const 1 i32.sub local.get $mask i32.and local.set $mask
    block $done
      loop $ties
        local.get $mask i32.eqz br_if $done
        local.get $mask i32.ctz local.set $lane
        local.get $ids local.get $first local.get $lane i32.add i32.const 2 i32.shl i32.add
        i32.load local.set $candidate_id
        local.get $candidate_id local.get $best_id i32.lt_u
        if
          local.get $lane local.set $best_lane
          local.get $candidate_id local.set $best_id
        end
        local.get $mask i32.const 1 i32.sub local.get $mask i32.and local.set $mask
        br $ties
      end
    end
    local.get $first local.get $best_lane i32.add
  )

  (func $heap_pop
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $output_id i32) (param $output_priority i32) (param $simd i32)
    (result i32)
    (local $next_size i32) (local $cursor i32) (local $first i32)
    (local $available i32) (local $child i32)
    (local $moving_priority f32) (local $moving_id i32)
    (local $child_priority f32) (local $child_id i32)
    local.get $output_id local.get $ids i32.load i32.store
    local.get $output_priority local.get $priorities f32.load f32.store
    local.get $size i32.const 1 i32.sub local.tee $next_size i32.eqz
    if local.get $next_size return end
    local.get $priorities local.get $next_size i32.const 2 i32.shl i32.add
    f32.load local.set $moving_priority
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
        f32.load local.set $child_priority
        local.get $ids local.get $child i32.const 2 i32.shl i32.add
        i32.load local.set $child_id
        local.get $child_priority local.get $child_id
        local.get $moving_priority local.get $moving_id call $less i32.eqz br_if $placed
        local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
        local.get $child_priority f32.store
        local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
        local.get $child_id i32.store
        local.get $child local.set $cursor
        br $down
      end
    end
    local.get $priorities local.get $cursor i32.const 2 i32.shl i32.add
    local.get $moving_priority f32.store
    local.get $ids local.get $cursor i32.const 2 i32.shl i32.add
    local.get $moving_id i32.store
    local.get $next_size
  )

  (func (export "pop_simd")
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $output_id i32) (param $output_priority i32) (result i32)
    local.get $priorities local.get $ids local.get $size
    local.get $output_id local.get $output_priority i32.const 1 call $heap_pop
  )

  (func (export "pop_scalar")
    (param $priorities i32) (param $ids i32) (param $size i32)
    (param $output_id i32) (param $output_priority i32) (result i32)
    local.get $priorities local.get $ids local.get $size
    local.get $output_id local.get $output_priority i32.const 0 call $heap_pop
  )

  (func $dijkstra
    (param $offsets i32) (param $targets i32) (param $weights i32)
    (param $node_count i32) (param $start i32) (param $target i32)
    (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (param $simd i32)
    (result f32)
    (local $index i32) (local $heap_size i32) (local $node i32)
    (local $edge i32) (local $edge_end i32) (local $neighbor i32)
    (local $distance f32) (local $next_distance f32)
    block $initialized
      loop $initialize
        local.get $index local.get $node_count i32.ge_u br_if $initialized
        local.get $distances local.get $index i32.const 2 i32.shl i32.add
        f32.const inf f32.store
        local.get $previous local.get $index i32.const 2 i32.shl i32.add
        i32.const -1 i32.store
        local.get $index i32.const 1 i32.add local.set $index
        br $initialize
      end
    end
    local.get $distances local.get $start i32.const 2 i32.shl i32.add
    f32.const 0 f32.store
    local.get $heap_priorities local.get $heap_ids i32.const 0
    local.get $start f32.const 0 call $heap_push local.set $heap_size
    block $done
      loop $search
        local.get $heap_size i32.eqz br_if $done
        local.get $heap_priorities local.get $heap_ids local.get $heap_size
        local.get $output_id local.get $output_priority local.get $simd
        call $heap_pop local.set $heap_size
        local.get $output_id i32.load local.set $node
        local.get $output_priority f32.load local.set $distance
        local.get $distance
        local.get $distances local.get $node i32.const 2 i32.shl i32.add f32.load
        f32.ne
        if br $search end
        local.get $node local.get $target i32.eq br_if $done
        local.get $offsets local.get $node i32.const 2 i32.shl i32.add i32.load local.set $edge
        local.get $offsets local.get $node i32.const 1 i32.add i32.const 2 i32.shl i32.add
        i32.load local.set $edge_end
        block $neighbors_done
          loop $neighbors
            local.get $edge local.get $edge_end i32.ge_u br_if $neighbors_done
            local.get $targets local.get $edge i32.const 2 i32.shl i32.add
            i32.load local.set $neighbor
            local.get $distance
            local.get $weights local.get $edge i32.const 2 i32.shl i32.add f32.load
            f32.add local.set $next_distance
            local.get $next_distance
            local.get $distances local.get $neighbor i32.const 2 i32.shl i32.add f32.load
            f32.lt
            if
              local.get $distances local.get $neighbor i32.const 2 i32.shl i32.add
              local.get $next_distance f32.store
              local.get $previous local.get $neighbor i32.const 2 i32.shl i32.add
              local.get $node i32.store
              local.get $heap_priorities local.get $heap_ids local.get $heap_size
              local.get $neighbor local.get $next_distance call $heap_push local.set $heap_size
            end
            local.get $edge i32.const 1 i32.add local.set $edge
            br $neighbors
          end
        end
        br $search
      end
    end
    local.get $distances local.get $target i32.const 2 i32.shl i32.add f32.load
  )

  (func (export "dijkstra_simd")
    (param $offsets i32) (param $targets i32) (param $weights i32)
    (param $node_count i32) (param $start i32) (param $target i32)
    (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (result f32)
    local.get $offsets local.get $targets local.get $weights
    local.get $node_count local.get $start local.get $target
    local.get $distances local.get $previous local.get $heap_priorities local.get $heap_ids
    local.get $output_id local.get $output_priority i32.const 1 call $dijkstra
  )

  (func (export "dijkstra_scalar")
    (param $offsets i32) (param $targets i32) (param $weights i32)
    (param $node_count i32) (param $start i32) (param $target i32)
    (param $distances i32) (param $previous i32)
    (param $heap_priorities i32) (param $heap_ids i32)
    (param $output_id i32) (param $output_priority i32) (result f32)
    local.get $offsets local.get $targets local.get $weights
    local.get $node_count local.get $start local.get $target
    local.get $distances local.get $previous local.get $heap_priorities local.get $heap_ids
    local.get $output_id local.get $output_priority i32.const 0 call $dijkstra
  )
)
