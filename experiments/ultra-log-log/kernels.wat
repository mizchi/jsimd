(module
  (import "jsimd" "memory" (memory 1))

  (func $mix32 (param $value i32) (result i32)
    local.get $value local.get $value i32.const 16 i32.shr_u i32.xor local.set $value
    local.get $value i32.const 0x7feb352d i32.mul local.set $value
    local.get $value local.get $value i32.const 15 i32.shr_u i32.xor local.set $value
    local.get $value i32.const 0x846ca68b i32.mul local.set $value
    local.get $value local.get $value i32.const 16 i32.shr_u i32.xor)

  ;; An UltraLogLog register keeps the largest event and two history bits. This
  ;; operation is associative and commutative, but is not an unsigned max.
  (func $merge_register (param $left i32) (param $right i32) (result i32)
    (local $left_rank i32) (local $right_rank i32)
    (local $larger i32) (local $smaller i32) (local $difference i32)
    local.get $left i32.eqz
    if local.get $right return end
    local.get $right i32.eqz
    if local.get $left return end
    local.get $left i32.const 2 i32.shr_u local.set $left_rank
    local.get $right i32.const 2 i32.shr_u local.set $right_rank
    local.get $left_rank local.get $right_rank i32.eq
    if
      local.get $left i32.const 0xfc i32.and
      local.get $left local.get $right i32.or i32.const 3 i32.and
      i32.or return
    end
    local.get $left_rank local.get $right_rank i32.gt_u
    if
      local.get $left local.set $larger
      local.get $right local.set $smaller
      local.get $left_rank local.get $right_rank i32.sub local.set $difference
    else
      local.get $right local.set $larger
      local.get $left local.set $smaller
      local.get $right_rank local.get $left_rank i32.sub local.set $difference
    end
    local.get $larger i32.const 3 i32.and local.set $right_rank
    local.get $difference i32.const 1 i32.eq
    if
      local.get $right_rank i32.const 2 i32.or
      local.get $smaller i32.const 1 i32.shr_u i32.const 1 i32.and i32.or
      local.set $right_rank
    else
      local.get $difference i32.const 2 i32.eq
      if local.get $right_rank i32.const 1 i32.or local.set $right_rank end
    end
    local.get $larger i32.const 0xfc i32.and local.get $right_rank i32.or)

  (func $merge_v128 (param $left v128) (param $right v128) (result v128)
    (local $left_rank v128) (local $right_rank v128)
    (local $high_rank v128) (local $low_rank v128) (local $difference v128)
    (local $left_is_larger v128) (local $same_rank v128)
    (local $larger v128) (local $smaller v128)
    (local $history v128) (local $result v128)
    local.get $left v128.const i8x16 252 252 252 252 252 252 252 252 252 252 252 252 252 252 252 252
    v128.and local.set $left_rank
    local.get $right v128.const i8x16 252 252 252 252 252 252 252 252 252 252 252 252 252 252 252 252
    v128.and local.set $right_rank
    local.get $left_rank local.get $right_rank i8x16.max_u local.set $high_rank
    local.get $left_rank local.get $right_rank i8x16.min_u local.set $low_rank
    local.get $high_rank local.get $low_rank i8x16.sub local.set $difference
    local.get $left_rank local.get $high_rank i8x16.eq local.set $left_is_larger
    local.get $left_rank local.get $right_rank i8x16.eq local.set $same_rank
    local.get $left local.get $right local.get $left_is_larger v128.bitselect local.set $larger
    local.get $right local.get $left local.get $left_is_larger v128.bitselect local.set $smaller

    local.get $larger v128.const i8x16 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 v128.and
    local.set $history
    ;; Difference one: record the previous largest event and its immediate history.
    local.get $history v128.const i8x16 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 v128.or
    local.get $smaller i32.const 1 i8x16.shr_u
    v128.const i8x16 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 v128.and v128.or
    local.get $history
    local.get $difference v128.const i8x16 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4 i8x16.eq
    v128.bitselect local.set $history
    ;; Difference two: only the second history bit is newly observed.
    local.get $history v128.const i8x16 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 v128.or
    local.get $history
    local.get $difference v128.const i8x16 8 8 8 8 8 8 8 8 8 8 8 8 8 8 8 8 i8x16.eq
    v128.bitselect local.set $history
    local.get $high_rank local.get $history v128.or local.set $result

    ;; Equal ranks combine history bits from both sides.
    local.get $high_rank
    local.get $left local.get $right v128.or
    v128.const i8x16 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 v128.and v128.or
    local.get $result local.get $same_rank v128.bitselect local.set $result
    ;; Zero is the empty-register sentinel, not a rank-zero event.
    local.get $right local.get $result
    local.get $left v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 i8x16.eq
    v128.bitselect local.set $result
    local.get $left local.get $result
    local.get $right v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 i8x16.eq
    v128.bitselect)

  (func (export "build_u32")
    (param $state i32) (param $precision i32) (param $values i32) (param $length i32)
    (local $register_count i32) (local $index i32) (local $value i32)
    (local $high i32) (local $low i32) (local $register_index i32)
    (local $shifted_high i32) (local $shifted_low i32)
    (local $leading_zeros i32) (local $event i32) (local $address i32)
    i32.const 1 local.get $precision i32.shl local.set $register_count
    local.get $state i32.const 0 local.get $register_count memory.fill
    block $done loop $loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $values local.get $index i32.const 2 i32.shl i32.add i32.load local.set $value
      local.get $value i32.const 0x9e3779b9 i32.xor call $mix32 local.set $high
      local.get $value i32.const 0x85ebca6b i32.xor call $mix32 local.set $low
      local.get $high i32.const 32 local.get $precision i32.sub i32.shr_u local.set $register_index
      local.get $high local.get $precision i32.shl
      local.get $low i32.const 32 local.get $precision i32.sub i32.shr_u i32.or
      local.set $shifted_high
      local.get $low local.get $precision i32.shl local.set $shifted_low
      local.get $shifted_high i32.eqz
      if
        local.get $shifted_low i32.clz i32.const 32 i32.add local.set $leading_zeros
        local.get $leading_zeros i32.const 64 local.get $precision i32.sub i32.gt_u
        if i32.const 64 local.get $precision i32.sub local.set $leading_zeros end
      else
        local.get $shifted_high i32.clz local.set $leading_zeros
      end
      local.get $precision i32.const 1 i32.sub local.get $leading_zeros i32.add
      i32.const 2 i32.shl i32.const 255 i32.and local.set $event
      local.get $state local.get $register_index i32.add local.tee $address
      local.get $address i32.load8_u local.get $event call $merge_register i32.store8
      local.get $index i32.const 1 i32.add local.set $index br $loop
    end end)

  (func (export "merge_states")
    (param $output i32) (param $states i32) (param $shard_count i32) (param $register_count i32)
    (local $shard i32) (local $index i32) (local $source i32)
    local.get $output local.get $states local.get $register_count memory.copy
    i32.const 1 local.set $shard
    block $shards_done loop $shards
      local.get $shard local.get $shard_count i32.ge_u br_if $shards_done
      local.get $states local.get $shard local.get $register_count i32.mul i32.add local.set $source
      i32.const 0 local.set $index
      block $vectors_done loop $vectors
        local.get $index i32.const 16 i32.add local.get $register_count i32.gt_u br_if $vectors_done
        local.get $output local.get $index i32.add
        local.get $output local.get $index i32.add v128.load
        local.get $source local.get $index i32.add v128.load call $merge_v128
        v128.store
        local.get $index i32.const 16 i32.add local.set $index br $vectors
      end end
      block $tail_done loop $tail
        local.get $index local.get $register_count i32.ge_u br_if $tail_done
        local.get $output local.get $index i32.add
        local.get $output local.get $index i32.add i32.load8_u
        local.get $source local.get $index i32.add i32.load8_u call $merge_register i32.store8
        local.get $index i32.const 1 i32.add local.set $index br $tail
      end end
      local.get $shard i32.const 1 i32.add local.set $shard br $shards
    end end)
)
