(module
  (import "jsimd" "memory" (memory 1 65536 shared))

  (func $packed_at (param $packed i32) (param $width i32) (param $index i32) (result i32)
    (local $bit i32) (local $word i32) (local $shift i32) (local $value i32)
    local.get $index local.get $width i32.mul local.set $bit
    local.get $bit i32.const 5 i32.shr_u local.set $word
    local.get $bit i32.const 31 i32.and local.set $shift
    local.get $packed local.get $word i32.const 2 i32.shl i32.add i32.load
    local.get $shift i32.shr_u local.set $value
    local.get $shift local.get $width i32.add i32.const 32 i32.gt_u
    if
      local.get $value
      local.get $packed local.get $word i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      i32.const 32 local.get $shift i32.sub i32.shl i32.or local.set $value
    end
    local.get $value i32.const 1 local.get $width i32.shl i32.const 1 i32.sub i32.and
  )

  (func $for4
    (param $packed i32) (param $width i32) (param $base i32) (param $index i32)
    (result v128)
    (local $values v128)
    local.get $base i32x4.splat local.set $values
    local.get $values local.get $base
    local.get $packed local.get $width local.get $index call $packed_at i32.add
    i32x4.replace_lane 0 local.set $values
    local.get $values local.get $base
    local.get $packed local.get $width local.get $index i32.const 1 i32.add call $packed_at i32.add
    i32x4.replace_lane 1 local.set $values
    local.get $values local.get $base
    local.get $packed local.get $width local.get $index i32.const 2 i32.add call $packed_at i32.add
    i32x4.replace_lane 2 local.set $values
    local.get $values local.get $base
    local.get $packed local.get $width local.get $index i32.const 3 i32.add call $packed_at i32.add
    i32x4.replace_lane 3
  )

  (func $local_group_hash (export "local_group_hash_u32") (param $key i32) (result i32)
    (local $hash i32)
    local.get $key
    local.get $key
    i32.const 16
    i32.shr_u
    i32.xor
    local.set $hash
    local.get $hash
    i32.const 0x7feb352d
    i32.mul
    local.set $hash
    local.get $hash
    local.get $hash
    i32.const 15
    i32.shr_u
    i32.xor
    local.set $hash
    local.get $hash
    i32.const 0x846ca68b
    i32.mul
    local.set $hash
    local.get $hash
    local.get $hash
    i32.const 16
    i32.shr_u
    i32.xor
  )

  (func $hash_join_bloom_mask (param $hash i32) (result v128)
    (local $mask v128)
    local.get $mask
    i32.const 1
    local.get $hash
    i32.const 31
    i32.and
    i32.shl
    i32x4.replace_lane 0
    local.set $mask
    local.get $mask
    i32.const 1
    local.get $hash
    i32.const 8
    i32.shr_u
    i32.const 31
    i32.and
    i32.shl
    i32x4.replace_lane 1
    local.set $mask
    local.get $mask
    i32.const 1
    local.get $hash
    i32.const 16
    i32.shr_u
    i32.const 31
    i32.and
    i32.shl
    i32x4.replace_lane 2
    local.set $mask
    local.get $mask
    i32.const 1
    local.get $hash
    i32.const 24
    i32.shr_u
    i32.const 31
    i32.and
    i32.shl
    i32x4.replace_lane 3
  )

  (func $hash_join_bloom_address
    (param $bloom i32)
    (param $blocks_per_partition i32)
    (param $partition i32)
    (param $hash i32)
    (result i32)
    local.get $bloom
    local.get $partition
    local.get $blocks_per_partition
    i32.mul
    local.get $hash
    i32.const 8
    i32.shr_u
    local.get $blocks_per_partition
    i32.rem_u
    i32.add
    i32.const 4
    i32.shl
    i32.add
  )

  (func $hash_join_bloom_add
    (param $bloom i32)
    (param $blocks_per_partition i32)
    (param $partition i32)
    (param $hash i32)
    (local $address i32)
    (local $mask v128)
    local.get $blocks_per_partition
    i32.eqz
    if
      return
    end
    local.get $bloom
    local.get $blocks_per_partition
    local.get $partition
    local.get $hash
    call $hash_join_bloom_address
    local.set $address
    local.get $hash
    i32.const 0x9e3779b9
    i32.xor
    call $local_group_hash
    call $hash_join_bloom_mask
    local.set $mask
    local.get $address
    local.get $address
    v128.load
    local.get $mask
    v128.or
    v128.store
  )

  (func $hash_join_bloom_may_contain
    (param $bloom i32)
    (param $blocks_per_partition i32)
    (param $partition i32)
    (param $hash i32)
    (result i32)
    (local $mask v128)
    local.get $blocks_per_partition
    i32.eqz
    if (result i32)
      i32.const 1
    else
      local.get $hash
      i32.const 0x9e3779b9
      i32.xor
      call $local_group_hash
      call $hash_join_bloom_mask
      local.set $mask
      local.get $bloom
      local.get $blocks_per_partition
      local.get $partition
      local.get $hash
      call $hash_join_bloom_address
      v128.load
      local.get $mask
      v128.and
      local.get $mask
      i32x4.eq
      i32x4.all_true
    end
  )

  ;; Returns (found << 32) | global slot. Every partition independently keeps an empty lane.
  (func $hash_join_probe
    (param $controls i32)
    (param $keys i32)
    (param $partition_count i32)
    (param $capacity i32)
    (param $key i32)
    (result i64)
    (local $hash i32)
    (local $fingerprint i32)
    (local $partition i32)
    (local $base i32)
    (local $offset i32)
    (local $matches i32)
    (local $empties i32)
    (local $lane i32)
    (local $slot i32)
    (local $group v128)

    local.get $key
    call $local_group_hash
    local.tee $hash
    local.get $partition_count
    i32.const 1
    i32.sub
    i32.and
    local.set $partition
    local.get $partition
    local.get $capacity
    i32.mul
    local.set $base
    local.get $hash
    i32.const 8
    i32.shr_u
    local.get $capacity
    i32.const 1
    i32.sub
    i32.and
    i32.const -16
    i32.and
    local.set $offset
    local.get $hash
    i32.const 25
    i32.shr_u
    local.set $fingerprint

    (loop $groups
      local.get $controls
      local.get $base
      local.get $offset
      i32.add
      i32.add
      v128.load
      local.tee $group
      local.get $fingerprint
      i8x16.splat
      i8x16.eq
      i8x16.bitmask
      local.set $matches
      (block $matches_done
        (loop $matches_loop
          local.get $matches
          i32.eqz
          br_if $matches_done
          local.get $matches
          i32.ctz
          local.set $lane
          local.get $base
          local.get $offset
          local.get $lane
          i32.add
          local.get $capacity
          i32.const 1
          i32.sub
          i32.and
          i32.add
          local.set $slot
          local.get $keys
          local.get $slot
          i32.const 2
          i32.shl
          i32.add
          i32.load align=4
          local.get $key
          i32.eq
          if
            i64.const 0x100000000
            local.get $slot
            i64.extend_i32_u
            i64.or
            return
          end
          local.get $matches
          local.get $matches
          i32.const 1
          i32.sub
          i32.and
          local.set $matches
          br $matches_loop
        )
      )
      local.get $group
      i32.const 128
      i8x16.splat
      i8x16.eq
      i8x16.bitmask
      local.tee $empties
      i32.eqz
      if
      else
        local.get $base
        local.get $offset
        local.get $empties
        i32.ctz
        i32.add
        local.get $capacity
        i32.const 1
        i32.sub
        i32.and
        i32.add
        i64.extend_i32_u
        return
      end
      local.get $offset
      i32.const 16
      i32.add
      local.get $capacity
      i32.const 1
      i32.sub
      i32.and
      local.set $offset
      br $groups
    )
    unreachable
  )

  (func (export "hash_join_build_u32")
    (param $input_keys i32)
    (param $input_rows i32)
    (param $length i32)
    (param $partition_sizes i32)
    (param $controls i32)
    (param $keys i32)
    (param $heads i32)
    (param $node_rows i32)
    (param $node_next i32)
    (param $bloom i32)
    (param $bloom_blocks i32)
    (param $build_rows_pointer i32)
    (param $distinct_pointer i32)
    (param $partition_count i32)
    (param $capacity i32)
    (param $max_size i32)
    (param $max_build_rows i32)
    (result i32)
    (local $index i32)
    (local $key i32)
    (local $hash i32)
    (local $partition i32)
    (local $probe i64)
    (local $slot i32)
    (local $inserted i32)
    (local $partition_size_pointer i32)

    local.get $length
    local.get $max_build_rows
    i32.gt_u
    if
      i32.const -2
      return
    end
    local.get $length
    local.set $index
    (block $done
      (loop $loop
        local.get $index
        i32.eqz
        br_if $done
        local.get $index
        i32.const 1
        i32.sub
        local.tee $index
        i32.const 2
        i32.shl
        local.get $input_keys
        i32.add
        i32.load align=4
        local.tee $key
        call $local_group_hash
        local.tee $hash
        local.get $partition_count
        i32.const 1
        i32.sub
        i32.and
        local.set $partition

        local.get $bloom
        local.get $bloom_blocks
        local.get $partition
        local.get $hash
        call $hash_join_bloom_add
        local.get $controls
        local.get $keys
        local.get $partition_count
        local.get $capacity
        local.get $key
        call $hash_join_probe
        local.tee $probe
        i64.const 32
        i64.shr_u
        i32.wrap_i64
        i32.eqz
        local.set $inserted
        local.get $probe
        i32.wrap_i64
        local.set $slot
        local.get $inserted
        if
          local.get $partition_sizes
          local.get $partition
          i32.const 2
          i32.shl
          i32.add
          local.tee $partition_size_pointer
          i32.load align=4
          local.get $max_size
          i32.ge_u
          if
            i32.const -1
            return
          end
          local.get $keys
          local.get $slot
          i32.const 2
          i32.shl
          i32.add
          local.get $key
          i32.store align=4
          local.get $controls
          local.get $slot
          i32.add
          local.get $hash
          i32.const 25
          i32.shr_u
          i32.store8
          local.get $heads
          local.get $slot
          i32.const 2
          i32.shl
          i32.add
          i32.const -1
          i32.store align=4
          local.get $partition_size_pointer
          local.get $partition_size_pointer
          i32.load align=4
          i32.const 1
          i32.add
          i32.store align=4
          local.get $distinct_pointer
          local.get $distinct_pointer
          i32.load align=4
          i32.const 1
          i32.add
          i32.store align=4
        end
        local.get $node_rows
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        local.get $input_rows
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        i32.store align=4
        local.get $node_next
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        local.get $heads
        local.get $slot
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        i32.store align=4
        local.get $heads
        local.get $slot
        i32.const 2
        i32.shl
        i32.add
        local.get $index
        i32.store align=4
        br $loop
      )
    )
    local.get $build_rows_pointer
    local.get $length
    i32.store align=4
    i32.const 0
  )

  ;; High 32 bits: Bloom-rejected probe rows. Low 32 bits: exact output pair count.
  (func (export "hash_join_count_u32")
    (param $probe_keys i32)
    (param $length i32)
    (param $controls i32)
    (param $keys i32)
    (param $heads i32)
    (param $node_next i32)
    (param $bloom i32)
    (param $bloom_blocks i32)
    (param $partition_count i32)
    (param $capacity i32)
    (result i64)
    (local $index i32)
    (local $key i32)
    (local $hash i32)
    (local $partition i32)
    (local $probe i64)
    (local $node i32)
    (local $matches i32)
    (local $rejected i32)

    (block $done
      (loop $loop
        local.get $index
        local.get $length
        i32.ge_u
        br_if $done
        local.get $probe_keys
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        local.tee $key
        call $local_group_hash
        local.tee $hash
        local.get $partition_count
        i32.const 1
        i32.sub
        i32.and
        local.set $partition
        local.get $bloom
        local.get $bloom_blocks
        local.get $partition
        local.get $hash
        call $hash_join_bloom_may_contain
        i32.eqz
        if
          local.get $rejected
          i32.const 1
          i32.add
          local.set $rejected
        else
          local.get $controls
          local.get $keys
          local.get $partition_count
          local.get $capacity
          local.get $key
          call $hash_join_probe
          local.tee $probe
          i64.const 32
          i64.shr_u
          i32.wrap_i64
          if
            local.get $heads
            local.get $probe
            i32.wrap_i64
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.set $node
            (block $chain_done
              (loop $chain
                local.get $node
                i32.const -1
                i32.eq
                br_if $chain_done
                local.get $matches
                i32.const 1
                i32.add
                local.set $matches
                local.get $node_next
                local.get $node
                i32.const 2
                i32.shl
                i32.add
                i32.load align=4
                local.set $node
                br $chain
              )
            )
          end
        end
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $loop
      )
    )
    local.get $rejected
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $matches
    i64.extend_i32_u
    i64.or
  )

  ;; High 32 bits: total matches. Low 32 bits: caller-capacity-bounded writes.
  (func (export "hash_join_probe_u32")
    (param $probe_keys i32)
    (param $probe_rows i32)
    (param $length i32)
    (param $output_probe_rows i32)
    (param $output_build_rows i32)
    (param $output_capacity i32)
    (param $controls i32)
    (param $keys i32)
    (param $heads i32)
    (param $node_rows i32)
    (param $node_next i32)
    (param $bloom i32)
    (param $bloom_blocks i32)
    (param $partition_count i32)
    (param $capacity i32)
    (result i64)
    (local $index i32)
    (local $key i32)
    (local $hash i32)
    (local $partition i32)
    (local $probe i64)
    (local $node i32)
    (local $matches i32)
    (local $written i32)

    (block $done
      (loop $loop
        local.get $index
        local.get $length
        i32.ge_u
        br_if $done
        local.get $probe_keys
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        local.tee $key
        call $local_group_hash
        local.tee $hash
        local.get $partition_count
        i32.const 1
        i32.sub
        i32.and
        local.set $partition
        local.get $bloom
        local.get $bloom_blocks
        local.get $partition
        local.get $hash
        call $hash_join_bloom_may_contain
        if
          local.get $controls
          local.get $keys
          local.get $partition_count
          local.get $capacity
          local.get $key
          call $hash_join_probe
          local.tee $probe
          i64.const 32
          i64.shr_u
          i32.wrap_i64
          if
            local.get $heads
            local.get $probe
            i32.wrap_i64
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.set $node
            (block $chain_done
              (loop $chain
                local.get $node
                i32.const -1
                i32.eq
                br_if $chain_done
                local.get $written
                local.get $output_capacity
                i32.lt_u
                if
                  local.get $output_probe_rows
                  local.get $written
                  i32.const 2
                  i32.shl
                  i32.add
                  local.get $probe_rows
                  local.get $index
                  i32.const 2
                  i32.shl
                  i32.add
                  i32.load align=4
                  i32.store align=4
                  local.get $output_build_rows
                  local.get $written
                  i32.const 2
                  i32.shl
                  i32.add
                  local.get $node_rows
                  local.get $node
                  i32.const 2
                  i32.shl
                  i32.add
                  i32.load align=4
                  i32.store align=4
                  local.get $written
                  i32.const 1
                  i32.add
                  local.set $written
                end
                local.get $matches
                i32.const 1
                i32.add
                local.set $matches
                local.get $node_next
                local.get $node
                i32.const 2
                i32.shl
                i32.add
                i32.load align=4
                local.set $node
                br $chain
              )
            )
          end
        end
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $loop
      )
    )
    local.get $matches
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $written
    i64.extend_i32_u
    i64.or
  )

  ;; Returns (found << 32) | slot. The 7/8 load-factor contract guarantees an empty lane.
  (func $local_group_probe
    (param $controls i32)
    (param $keys i32)
    (param $capacity i32)
    (param $key i32)
    (result i64)
    (local $hash i32)
    (local $fingerprint i32)
    (local $offset i32)
    (local $matches i32)
    (local $empties i32)
    (local $lane i32)
    (local $slot i32)
    (local $group v128)

    local.get $key
    call $local_group_hash
    local.tee $hash
    local.get $capacity
    i32.const 1
    i32.sub
    i32.and
    i32.const -16
    i32.and
    local.set $offset
    local.get $hash
    i32.const 25
    i32.shr_u
    local.set $fingerprint

    (loop $groups
      local.get $controls
      local.get $offset
      i32.add
      v128.load
      local.tee $group
      local.get $fingerprint
      i8x16.splat
      i8x16.eq
      i8x16.bitmask
      local.set $matches

      (block $matches_done
        (loop $matches_loop
          local.get $matches
          i32.eqz
          br_if $matches_done
          local.get $matches
          i32.ctz
          local.set $lane
          local.get $offset
          local.get $lane
          i32.add
          local.get $capacity
          i32.const 1
          i32.sub
          i32.and
          local.set $slot
          local.get $keys
          local.get $slot
          i32.const 2
          i32.shl
          i32.add
          i32.load
          local.get $key
          i32.eq
          if
            i64.const 0x100000000
            local.get $slot
            i64.extend_i32_u
            i64.or
            return
          end
          local.get $matches
          local.get $matches
          i32.const 1
          i32.sub
          i32.and
          local.set $matches
          br $matches_loop
        )
      )

      local.get $group
      i32.const 128
      i8x16.splat
      i8x16.eq
      i8x16.bitmask
      local.tee $empties
      i32.eqz
      if
      else
        local.get $offset
        local.get $empties
        i32.ctz
        i32.add
        local.get $capacity
        i32.const 1
        i32.sub
        i32.and
        i64.extend_i32_u
        return
      end
      local.get $offset
      i32.const 16
      i32.add
      local.get $capacity
      i32.const 1
      i32.sub
      i32.and
      local.set $offset
      br $groups
    )
    unreachable
  )

  (func (export "local_group_find")
    (param $controls i32)
    (param $keys i32)
    (param $capacity i32)
    (param $key i32)
    (result i32)
    (local $result i64)
    local.get $controls
    local.get $keys
    local.get $capacity
    local.get $key
    call $local_group_probe
    local.tee $result
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    if (result i32)
      local.get $result
      i32.wrap_i64
    else
      i32.const -1
    end
  )

  (func $local_group_update_i32 (export "local_group_update_i32")
    (param $controls i32)
    (param $keys i32)
    (param $counts i32)
    (param $null_counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (param $size_pointer i32)
    (param $capacity i32)
    (param $max_size i32)
    (param $key i32)
    (param $value i32)
    (param $valid i32)
    (result i32)
    (local $result i64)
    (local $slot i32)
    (local $inserted i32)
    (local $word_offset i32)
    (local $sum_offset i32)
    (local $count i32)

    local.get $controls
    local.get $keys
    local.get $capacity
    local.get $key
    call $local_group_probe
    local.tee $result
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    i32.eqz
    local.set $inserted
    local.get $result
    i32.wrap_i64
    local.set $slot

    local.get $inserted
    if
      local.get $size_pointer
      i32.load align=4
      local.get $max_size
      i32.ge_u
      if
        i32.const -1
        return
      end
      local.get $keys
      local.get $slot
      i32.const 2
      i32.shl
      i32.add
      local.get $key
      i32.store align=4
      local.get $controls
      local.get $slot
      i32.add
      local.get $key
      call $local_group_hash
      i32.const 25
      i32.shr_u
      i32.store8
      local.get $size_pointer
      local.get $size_pointer
      i32.load align=4
      i32.const 1
      i32.add
      i32.store align=4
    end

    local.get $slot
    i32.const 2
    i32.shl
    local.set $word_offset
    local.get $slot
    i32.const 3
    i32.shl
    local.set $sum_offset
    local.get $valid
    if
      local.get $counts
      local.get $word_offset
      i32.add
      i32.load align=4
      local.set $count
      local.get $counts
      local.get $word_offset
      i32.add
      local.get $count
      i32.const 1
      i32.add
      i32.store align=4
      local.get $sums
      local.get $sum_offset
      i32.add
      local.get $sums
      local.get $sum_offset
      i32.add
      i64.load align=8
      local.get $value
      i64.extend_i32_s
      i64.add
      i64.store align=8
      local.get $count
      i32.eqz
      if
        local.get $minimums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
        local.get $maximums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
      else
        local.get $value
        local.get $minimums
        local.get $word_offset
        i32.add
        i32.load align=4
        i32.lt_s
        if
          local.get $minimums
          local.get $word_offset
          i32.add
          local.get $value
          i32.store align=4
        end
        local.get $value
        local.get $maximums
        local.get $word_offset
        i32.add
        i32.load align=4
        i32.gt_s
        if
          local.get $maximums
          local.get $word_offset
          i32.add
          local.get $value
          i32.store align=4
        end
      end
    else
      local.get $null_counts
      local.get $word_offset
      i32.add
      local.get $null_counts
      local.get $word_offset
      i32.add
      i32.load align=4
      i32.const 1
      i32.add
      i32.store align=4
    end
    local.get $inserted
  )

  (func (export "local_group_aggregate_i32")
    (param $input_keys i32)
    (param $input_values i32)
    (param $input_validities i32)
    (param $has_validities i32)
    (param $length i32)
    (param $controls i32)
    (param $keys i32)
    (param $counts i32)
    (param $null_counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (param $size_pointer i32)
    (param $capacity i32)
    (param $max_size i32)
    (result i32)
    (local $index i32)
    (local $result i32)
    (local $inserted i32)

    (block $done
      (loop $loop
        local.get $index
        local.get $length
        i32.ge_u
        br_if $done
        local.get $controls
        local.get $keys
        local.get $counts
        local.get $null_counts
        local.get $sums
        local.get $minimums
        local.get $maximums
        local.get $size_pointer
        local.get $capacity
        local.get $max_size
        local.get $input_keys
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        local.get $input_values
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        local.get $has_validities
        if (result i32)
          local.get $input_validities
          local.get $index
          i32.add
          i32.load8_u
        else
          i32.const 1
        end
        call $local_group_update_i32
        local.tee $result
        i32.const 0
        i32.lt_s
        if
          i32.const -1
          return
        end
        local.get $inserted
        local.get $result
        i32.add
        local.set $inserted
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $loop
      )
    )
    local.get $inserted
  )

  ;; Applies [minimum, maximum) to four signed i32 filter values at a time, then
  ;; materializes only selected rows into the sparse u32 group table.
  (func (export "local_group_aggregate_between_i32_u32")
    (param $filter i32)
    (param $input_keys i32)
    (param $input_values i32)
    (param $input_validities i32)
    (param $has_validities i32)
    (param $length i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $controls i32)
    (param $keys i32)
    (param $counts i32)
    (param $null_counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (param $size_pointer i32)
    (param $capacity i32)
    (param $max_size i32)
    (result i32)
    (local $index i32)
    (local $mask i32)
    (local $lane i32)
    (local $row i32)
    (local $result i32)
    (local $inserted i32)
    (local $filters v128)

    (block $simd_done
      (loop $simd
        local.get $index
        i32.const 4
        i32.add
        local.get $length
        i32.gt_u
        br_if $simd_done

        local.get $filter
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        v128.load align=4
        local.tee $filters
        local.get $minimum
        i32x4.splat
        i32x4.ge_s
        local.get $filters
        local.get $maximum
        i32x4.splat
        i32x4.lt_s
        v128.and
        i32x4.bitmask
        local.set $mask

        (block $lanes_done
          (loop $lanes
            local.get $mask
            i32.eqz
            br_if $lanes_done
            local.get $mask
            i32.ctz
            local.set $lane
            local.get $index
            local.get $lane
            i32.add
            local.set $row

            local.get $controls
            local.get $keys
            local.get $counts
            local.get $null_counts
            local.get $sums
            local.get $minimums
            local.get $maximums
            local.get $size_pointer
            local.get $capacity
            local.get $max_size
            local.get $input_keys
            local.get $row
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.get $input_values
            local.get $row
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.get $has_validities
            if (result i32)
              local.get $input_validities
              local.get $row
              i32.add
              i32.load8_u
            else
              i32.const 1
            end
            call $local_group_update_i32
            local.tee $result
            i32.const 0
            i32.lt_s
            if
              i32.const -1
              return
            end
            local.get $inserted
            local.get $result
            i32.add
            local.set $inserted
            local.get $mask
            local.get $mask
            i32.const 1
            i32.sub
            i32.and
            local.set $mask
            br $lanes
          )
        )
        local.get $index
        i32.const 4
        i32.add
        local.set $index
        br $simd
      )
    )

    (block $done
      (loop $tail
        local.get $index
        local.get $length
        i32.ge_u
        br_if $done
        local.get $filter
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load align=4
        local.get $minimum
        i32.ge_s
        if
          local.get $filter
          local.get $index
          i32.const 2
          i32.shl
          i32.add
          i32.load align=4
          local.get $maximum
          i32.lt_s
          if
            local.get $controls
            local.get $keys
            local.get $counts
            local.get $null_counts
            local.get $sums
            local.get $minimums
            local.get $maximums
            local.get $size_pointer
            local.get $capacity
            local.get $max_size
            local.get $input_keys
            local.get $index
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.get $input_values
            local.get $index
            i32.const 2
            i32.shl
            i32.add
            i32.load align=4
            local.get $has_validities
            if (result i32)
              local.get $input_validities
              local.get $index
              i32.add
              i32.load8_u
            else
              i32.const 1
            end
            call $local_group_update_i32
            local.tee $result
            i32.const 0
            i32.lt_s
            if
              i32.const -1
              return
            end
            local.get $inserted
            local.get $result
            i32.add
            local.set $inserted
          end
        end
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $tail
      )
    )
    local.get $inserted
  )

  (func $local_group_merge_state
    (param $controls i32)
    (param $keys i32)
    (param $counts i32)
    (param $null_counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (param $size_pointer i32)
    (param $capacity i32)
    (param $max_size i32)
    (param $key i32)
    (param $source_count i32)
    (param $source_null_count i32)
    (param $source_sum i64)
    (param $source_minimum i32)
    (param $source_maximum i32)
    (result i32)
    (local $result i64)
    (local $slot i32)
    (local $inserted i32)
    (local $word_offset i32)
    (local $sum_offset i32)
    (local $destination_count i32)

    local.get $controls
    local.get $keys
    local.get $capacity
    local.get $key
    call $local_group_probe
    local.tee $result
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    i32.eqz
    local.set $inserted
    local.get $result
    i32.wrap_i64
    local.set $slot
    local.get $inserted
    if
      local.get $size_pointer
      i32.load align=4
      local.get $max_size
      i32.ge_u
      if
        i32.const -1
        return
      end
      local.get $keys
      local.get $slot
      i32.const 2
      i32.shl
      i32.add
      local.get $key
      i32.store align=4
      local.get $controls
      local.get $slot
      i32.add
      local.get $key
      call $local_group_hash
      i32.const 25
      i32.shr_u
      i32.store8
      local.get $size_pointer
      local.get $size_pointer
      i32.load align=4
      i32.const 1
      i32.add
      i32.store align=4
    end

    local.get $slot
    i32.const 2
    i32.shl
    local.set $word_offset
    local.get $slot
    i32.const 3
    i32.shl
    local.set $sum_offset
    local.get $counts
    local.get $word_offset
    i32.add
    i32.load align=4
    local.set $destination_count
    local.get $counts
    local.get $word_offset
    i32.add
    local.get $destination_count
    local.get $source_count
    i32.add
    i32.store align=4
    local.get $null_counts
    local.get $word_offset
    i32.add
    local.get $null_counts
    local.get $word_offset
    i32.add
    i32.load align=4
    local.get $source_null_count
    i32.add
    i32.store align=4
    local.get $sums
    local.get $sum_offset
    i32.add
    local.get $sums
    local.get $sum_offset
    i32.add
    i64.load align=8
    local.get $source_sum
    i64.add
    i64.store align=8

    local.get $source_count
    if
      local.get $destination_count
      i32.eqz
      if
        local.get $minimums
        local.get $word_offset
        i32.add
        local.get $source_minimum
        i32.store align=4
        local.get $maximums
        local.get $word_offset
        i32.add
        local.get $source_maximum
        i32.store align=4
      else
        local.get $source_minimum
        local.get $minimums
        local.get $word_offset
        i32.add
        i32.load align=4
        i32.lt_s
        if
          local.get $minimums
          local.get $word_offset
          i32.add
          local.get $source_minimum
          i32.store align=4
        end
        local.get $source_maximum
        local.get $maximums
        local.get $word_offset
        i32.add
        i32.load align=4
        i32.gt_s
        if
          local.get $maximums
          local.get $word_offset
          i32.add
          local.get $source_maximum
          i32.store align=4
        end
      end
    end
    local.get $inserted
  )

  (func (export "local_group_merge_partition")
    (param $destination_controls i32)
    (param $destination_keys i32)
    (param $destination_counts i32)
    (param $destination_null_counts i32)
    (param $destination_sums i32)
    (param $destination_minimums i32)
    (param $destination_maximums i32)
    (param $destination_size_pointer i32)
    (param $destination_capacity i32)
    (param $destination_max_size i32)
    (param $source_controls i32)
    (param $source_keys i32)
    (param $source_counts i32)
    (param $source_null_counts i32)
    (param $source_sums i32)
    (param $source_minimums i32)
    (param $source_maximums i32)
    (param $source_capacity i32)
    (param $partition i32)
    (param $partition_mask i32)
    (result i32)
    (local $slot i32)
    (local $key i32)
    (local $result i32)
    (local $inserted i32)
    (local $word_offset i32)
    (local $sum_offset i32)

    (block $done
      (loop $loop
        local.get $slot
        local.get $source_capacity
        i32.ge_u
        br_if $done
        local.get $source_controls
        local.get $slot
        i32.add
        i32.load8_u
        i32.const 128
        i32.lt_u
        if
          local.get $source_keys
          local.get $slot
          i32.const 2
          i32.shl
          i32.add
          i32.load align=4
          local.tee $key
          call $local_group_hash
          local.get $partition_mask
          i32.and
          local.get $partition
          i32.eq
          if
            local.get $slot
            i32.const 2
            i32.shl
            local.set $word_offset
            local.get $slot
            i32.const 3
            i32.shl
            local.set $sum_offset
            local.get $destination_controls
            local.get $destination_keys
            local.get $destination_counts
            local.get $destination_null_counts
            local.get $destination_sums
            local.get $destination_minimums
            local.get $destination_maximums
            local.get $destination_size_pointer
            local.get $destination_capacity
            local.get $destination_max_size
            local.get $key
            local.get $source_counts
            local.get $word_offset
            i32.add
            i32.load align=4
            local.get $source_null_counts
            local.get $word_offset
            i32.add
            i32.load align=4
            local.get $source_sums
            local.get $sum_offset
            i32.add
            i64.load align=8
            local.get $source_minimums
            local.get $word_offset
            i32.add
            i32.load align=4
            local.get $source_maximums
            local.get $word_offset
            i32.add
            i32.load align=4
            call $local_group_merge_state
            local.tee $result
            i32.const 0
            i32.lt_s
            if
              i32.const -1
              return
            end
            local.get $inserted
            local.get $result
            i32.add
            local.set $inserted
          end
        end
        local.get $slot
        i32.const 1
        i32.add
        local.set $slot
        br $loop
      )
    )
    local.get $inserted
  )

  ;; Barrier-delimited merge of two disjoint aggregate state blocks.
  ;; Counts/null counts and extrema use four i32 lanes; sums use two i64x2 vectors.
  (func (export "merge_aggregate_state_blocks")
    (param $destination_counts i32)
    (param $destination_null_counts i32)
    (param $destination_sums i32)
    (param $destination_minimums i32)
    (param $destination_maximums i32)
    (param $source_counts i32)
    (param $source_null_counts i32)
    (param $source_sums i32)
    (param $source_minimums i32)
    (param $source_maximums i32)
    (param $length i32)
    (local $destination_value i32)
    (local $source_value i32)

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $destination_counts
        local.get $destination_counts
        v128.load align=4
        local.get $source_counts
        v128.load align=4
        i32x4.add
        v128.store align=4

        local.get $destination_null_counts
        local.get $destination_null_counts
        v128.load align=4
        local.get $source_null_counts
        v128.load align=4
        i32x4.add
        v128.store align=4

        local.get $destination_sums
        local.get $destination_sums
        v128.load align=8
        local.get $source_sums
        v128.load align=8
        i64x2.add
        v128.store align=8
        local.get $destination_sums
        i32.const 16
        i32.add
        local.get $destination_sums
        v128.load offset=16 align=8
        local.get $source_sums
        v128.load offset=16 align=8
        i64x2.add
        v128.store align=8

        local.get $destination_minimums
        local.get $destination_minimums
        v128.load align=4
        local.get $source_minimums
        v128.load align=4
        i32x4.min_s
        v128.store align=4

        local.get $destination_maximums
        local.get $destination_maximums
        v128.load align=4
        local.get $source_maximums
        v128.load align=4
        i32x4.max_s
        v128.store align=4

        local.get $destination_counts
        i32.const 16
        i32.add
        local.set $destination_counts
        local.get $destination_null_counts
        i32.const 16
        i32.add
        local.set $destination_null_counts
        local.get $destination_sums
        i32.const 32
        i32.add
        local.set $destination_sums
        local.get $destination_minimums
        i32.const 16
        i32.add
        local.set $destination_minimums
        local.get $destination_maximums
        i32.const 16
        i32.add
        local.set $destination_maximums
        local.get $source_counts
        i32.const 16
        i32.add
        local.set $source_counts
        local.get $source_null_counts
        i32.const 16
        i32.add
        local.set $source_null_counts
        local.get $source_sums
        i32.const 32
        i32.add
        local.set $source_sums
        local.get $source_minimums
        i32.const 16
        i32.add
        local.set $source_minimums
        local.get $source_maximums
        i32.const 16
        i32.add
        local.set $source_maximums
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done

        local.get $destination_counts
        local.get $destination_counts
        i32.load align=4
        local.get $source_counts
        i32.load align=4
        i32.add
        i32.store align=4
        local.get $destination_null_counts
        local.get $destination_null_counts
        i32.load align=4
        local.get $source_null_counts
        i32.load align=4
        i32.add
        i32.store align=4
        local.get $destination_sums
        local.get $destination_sums
        i64.load align=8
        local.get $source_sums
        i64.load align=8
        i64.add
        i64.store align=8
        local.get $destination_minimums
        i32.load align=4
        local.set $destination_value
        local.get $source_minimums
        i32.load align=4
        local.set $source_value
        local.get $destination_minimums
        local.get $destination_value
        local.get $source_value
        local.get $destination_value
        local.get $source_value
        i32.lt_s
        select
        i32.store align=4
        local.get $destination_maximums
        i32.load align=4
        local.set $destination_value
        local.get $source_maximums
        i32.load align=4
        local.set $source_value
        local.get $destination_maximums
        local.get $destination_value
        local.get $source_value
        local.get $destination_value
        local.get $source_value
        i32.gt_s
        select
        i32.store align=4

        local.get $destination_counts
        i32.const 4
        i32.add
        local.set $destination_counts
        local.get $destination_null_counts
        i32.const 4
        i32.add
        local.set $destination_null_counts
        local.get $destination_sums
        i32.const 8
        i32.add
        local.set $destination_sums
        local.get $destination_minimums
        i32.const 4
        i32.add
        local.set $destination_minimums
        local.get $destination_maximums
        i32.const 4
        i32.add
        local.set $destination_maximums
        local.get $source_counts
        i32.const 4
        i32.add
        local.set $source_counts
        local.get $source_null_counts
        i32.const 4
        i32.add
        local.set $source_null_counts
        local.get $source_sums
        i32.const 8
        i32.add
        local.set $source_sums
        local.get $source_minimums
        i32.const 4
        i32.add
        local.set $source_minimums
        local.get $source_maximums
        i32.const 4
        i32.add
        local.set $source_maximums
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )
  )

  ;; Scans [pointer, pointer + length * 4) for minimum <= value < maximum.
  ;; The caller owns result: u32 count at +0 and signed i64 sum at +8.
  (func (export "scan_i32_between_aggregate")
    (param $pointer i32)
    (param $length i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $result i32)
    (local $values v128)
    (local $mask v128)
    (local $selected v128)
    (local $counts v128)
    (local $sum_low v128)
    (local $sum_high v128)
    (local $count i32)
    (local $sum i64)
    (local $value i32)

    v128.const i32x4 0 0 0 0
    local.set $counts
    v128.const i64x2 0 0
    local.set $sum_low
    v128.const i64x2 0 0
    local.set $sum_high

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $pointer
        v128.load align=4
        local.tee $values
        local.get $minimum
        i32x4.splat
        i32x4.ge_s
        local.get $values
        local.get $maximum
        i32x4.splat
        i32x4.lt_s
        v128.and
        local.set $mask

        local.get $counts
        local.get $mask
        i32x4.sub
        local.set $counts

        local.get $values
        local.get $mask
        v128.and
        local.tee $selected
        i64x2.extend_low_i32x4_s
        local.get $sum_low
        i64x2.add
        local.set $sum_low

        local.get $selected
        i64x2.extend_high_i32x4_s
        local.get $sum_high
        i64x2.add
        local.set $sum_high

        local.get $pointer
        i32.const 16
        i32.add
        local.set $pointer
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    local.get $counts
    i32x4.extract_lane 0
    local.get $counts
    i32x4.extract_lane 1
    i32.add
    local.get $counts
    i32x4.extract_lane 2
    i32.add
    local.get $counts
    i32x4.extract_lane 3
    i32.add
    local.set $count

    local.get $sum_low
    i64x2.extract_lane 0
    local.get $sum_low
    i64x2.extract_lane 1
    i64.add
    local.get $sum_high
    i64x2.extract_lane 0
    i64.add
    local.get $sum_high
    i64x2.extract_lane 1
    i64.add
    local.set $sum

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done

        local.get $pointer
        i32.load align=4
        local.tee $value
        local.get $minimum
        i32.ge_s
        local.get $value
        local.get $maximum
        i32.lt_s
        i32.and
        if
          local.get $count
          i32.const 1
          i32.add
          local.set $count
          local.get $sum
          local.get $value
          i64.extend_i32_s
          i64.add
          local.set $sum
        end

        local.get $pointer
        i32.const 4
        i32.add
        local.set $pointer
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )

    local.get $result
    local.get $count
    i32.store align=4
    local.get $result
    local.get $sum
    i64.store offset=8 align=8
  )

  ;; Constant pages aggregate without visiting logical rows.
  (func (export "aggregate_i32_constant")
    (param $length i32)
    (param $value i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $result i32)
    (local $selected i32)
    local.get $value local.get $minimum i32.ge_s
    local.get $value local.get $maximum i32.lt_s i32.and local.set $selected
    local.get $result local.get $length local.get $selected i32.mul i32.store align=4
    local.get $result
    local.get $value i64.extend_i32_s
    local.get $length i64.extend_i32_u i64.mul
    local.get $selected i64.extend_i32_u i64.mul
    i64.store offset=8 align=8
  )

  ;; Scans frame-of-reference AdaptiveI32 pages. The encoding parameter remains in the descriptor
  ;; ABI for validation/evolution, but dispatch selects this function only for FOR pages.
  (func (export "scan_adaptive_i32_between_aggregate")
    (param $pointer i32)
    (param $length i32)
    (param $encoding i32)
    (param $width i32)
    (param $base i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $result i32)
    (local $index i32)
    (local $values v128)
    (local $mask v128)
    (local $selected v128)
    (local $counts v128)
    (local $sum_low v128)
    (local $sum_high v128)
    (local $count i32)
    (local $sum i64)
    (local $value i32)

    v128.const i32x4 0 0 0 0 local.set $counts
    v128.const i64x2 0 0 local.set $sum_low
    v128.const i64x2 0 0 local.set $sum_high

    (block $simd_done
      (loop $simd
        local.get $length local.get $index i32.sub i32.const 4 i32.lt_u br_if $simd_done
        local.get $pointer local.get $width local.get $base local.get $index call $for4
        local.set $values

        local.get $values local.get $minimum i32x4.splat i32x4.ge_s
        local.get $values local.get $maximum i32x4.splat i32x4.lt_s
        v128.and local.set $mask
        local.get $counts local.get $mask i32x4.sub local.set $counts
        local.get $values local.get $mask v128.and local.tee $selected
        i64x2.extend_low_i32x4_s local.get $sum_low i64x2.add local.set $sum_low
        local.get $selected i64x2.extend_high_i32x4_s
        local.get $sum_high i64x2.add local.set $sum_high
        local.get $index i32.const 4 i32.add local.set $index
        br $simd
      )
    )

    local.get $counts i32x4.extract_lane 0
    local.get $counts i32x4.extract_lane 1 i32.add
    local.get $counts i32x4.extract_lane 2 i32.add
    local.get $counts i32x4.extract_lane 3 i32.add local.set $count
    local.get $sum_low i64x2.extract_lane 0
    local.get $sum_low i64x2.extract_lane 1 i64.add
    local.get $sum_high i64x2.extract_lane 0 i64.add
    local.get $sum_high i64x2.extract_lane 1 i64.add local.set $sum

    (block $scalar_done
      (loop $scalar
        local.get $index local.get $length i32.ge_u br_if $scalar_done
        local.get $base
        local.get $pointer local.get $width local.get $index call $packed_at i32.add
        local.tee $value
        local.get $minimum i32.ge_s
        local.get $value local.get $maximum i32.lt_s i32.and
        if
          local.get $count i32.const 1 i32.add local.set $count
          local.get $sum local.get $value i64.extend_i32_s i64.add local.set $sum
        end
        local.get $index i32.const 1 i32.add local.set $index
        br $scalar
      )
    )
    local.get $result local.get $count i32.store align=4
    local.get $result local.get $sum i64.store offset=8 align=8
  )

  (func $group_update
    (param $group i32)
    (param $value i32)
    (param $counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (local $word_offset i32)
    (local $sum_offset i32)
    (local $count i32)

    local.get $group
    i32.const 2
    i32.shl
    local.set $word_offset
    local.get $group
    i32.const 3
    i32.shl
    local.set $sum_offset

    local.get $counts
    local.get $word_offset
    i32.add
    i32.load align=4
    local.set $count

    local.get $counts
    local.get $word_offset
    i32.add
    local.get $count
    i32.const 1
    i32.add
    i32.store align=4

    local.get $sums
    local.get $sum_offset
    i32.add
    local.get $sums
    local.get $sum_offset
    i32.add
    i64.load align=8
    local.get $value
    i64.extend_i32_s
    i64.add
    i64.store align=8

    local.get $count
    i32.eqz
    if
      local.get $minimums
      local.get $word_offset
      i32.add
      local.get $value
      i32.store align=4
      local.get $maximums
      local.get $word_offset
      i32.add
      local.get $value
      i32.store align=4
    else
      local.get $value
      local.get $minimums
      local.get $word_offset
      i32.add
      i32.load align=4
      i32.lt_s
      if
        local.get $minimums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
      end
      local.get $value
      local.get $maximums
      local.get $word_offset
      i32.add
      i32.load align=4
      i32.gt_s
      if
        local.get $maximums
        local.get $word_offset
        i32.add
        local.get $value
        i32.store align=4
      end
    end
  )

  ;; Filters four i32 rows at a time, then updates worker-private low-cardinality u8 groups.
  (func (export "scan_i32_between_group_by_u8")
    (param $filter i32)
    (param $values i32)
    (param $groups i32)
    (param $length i32)
    (param $minimum i32)
    (param $maximum i32)
    (param $counts i32)
    (param $sums i32)
    (param $minimums i32)
    (param $maximums i32)
    (local $filters v128)
    (local $mask i32)
    (local $filter_value i32)

    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $filter
        v128.load align=4
        local.tee $filters
        local.get $minimum
        i32x4.splat
        i32x4.ge_s
        local.get $filters
        local.get $maximum
        i32x4.splat
        i32x4.lt_s
        v128.and
        i32x4.bitmask
        local.set $mask

        local.get $mask
        i32.const 1
        i32.and
        if
          local.get $groups
          i32.load8_u
          local.get $values
          i32.load align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 2
        i32.and
        if
          local.get $groups
          i32.load8_u offset=1
          local.get $values
          i32.load offset=4 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 4
        i32.and
        if
          local.get $groups
          i32.load8_u offset=2
          local.get $values
          i32.load offset=8 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $mask
        i32.const 8
        i32.and
        if
          local.get $groups
          i32.load8_u offset=3
          local.get $values
          i32.load offset=12 align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end

        local.get $filter
        i32.const 16
        i32.add
        local.set $filter
        local.get $values
        i32.const 16
        i32.add
        local.set $values
        local.get $groups
        i32.const 4
        i32.add
        local.set $groups
        local.get $length
        i32.const 4
        i32.sub
        local.set $length
        br $simd
      )
    )

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done
        local.get $filter
        i32.load align=4
        local.tee $filter_value
        local.get $minimum
        i32.ge_s
        local.get $filter_value
        local.get $maximum
        i32.lt_s
        i32.and
        if
          local.get $groups
          i32.load8_u
          local.get $values
          i32.load align=4
          local.get $counts
          local.get $sums
          local.get $minimums
          local.get $maximums
          call $group_update
        end
        local.get $filter
        i32.const 4
        i32.add
        local.set $filter
        local.get $values
        i32.const 4
        i32.add
        local.set $values
        local.get $groups
        i32.const 1
        i32.add
        local.set $groups
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )
  )
)
