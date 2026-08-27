(module
  (memory (export "memory") 1)

  (func $horizontal_popcount (param $value v128) (result i32)
    (local $lanes v128)
    local.get $value i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
    i32x4.extadd_pairwise_i16x8_u local.set $lanes
    local.get $lanes i32x4.extract_lane 0
    local.get $lanes i32x4.extract_lane 1 i32.add
    local.get $lanes i32x4.extract_lane 2 i32.add
    local.get $lanes i32x4.extract_lane 3 i32.add)

  (func (export "build_rank_index")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (result i32)
    (local $super i32) (local $word i32) (local $end i32) (local $count i32)
    block $done loop $super_loop
      local.get $super local.get $superblocks i32.ge_u br_if $done
      local.get $rank_index local.get $super i32.const 2 i32.shl i32.add
      local.get $count i32.store
      local.get $super i32.const 4 i32.shl local.tee $word
      i32.const 16 i32.add local.set $end
      local.get $end local.get $padded_words i32.gt_u
      if local.get $padded_words local.set $end end
      block $words_done loop $words_loop
        local.get $word local.get $end i32.ge_u br_if $words_done
        local.get $count
        local.get $bits local.get $word i32.const 2 i32.shl i32.add v128.load
        call $horizontal_popcount i32.add local.set $count
        local.get $word i32.const 4 i32.add local.set $word br $words_loop
      end end
      local.get $super i32.const 1 i32.add local.set $super br $super_loop
    end end
    local.get $rank_index local.get $superblocks i32.const 2 i32.shl i32.add
    local.get $count i32.store
    local.get $count)

  (func $rank1
    (param $bits i32) (param $rank_index i32) (param $end i32) (result i32)
    (local $super i32) (local $word i32) (local $full_words i32)
    (local $remaining_bits i32) (local $count i32)
    local.get $end i32.const 9 i32.shr_u local.tee $super
    i32.const 4 i32.shl local.set $word
    local.get $rank_index local.get $super i32.const 2 i32.shl i32.add i32.load
    local.set $count
    local.get $end i32.const 5 i32.shr_u local.set $full_words
    block $vectors_done loop $vectors_loop
      local.get $word i32.const 4 i32.add local.get $full_words i32.gt_u br_if $vectors_done
      local.get $count
      local.get $bits local.get $word i32.const 2 i32.shl i32.add v128.load
      call $horizontal_popcount i32.add local.set $count
      local.get $word i32.const 4 i32.add local.set $word br $vectors_loop
    end end
    block $words_done loop $words_loop
      local.get $word local.get $full_words i32.ge_u br_if $words_done
      local.get $count
      local.get $bits local.get $word i32.const 2 i32.shl i32.add i32.load i32.popcnt
      i32.add local.set $count
      local.get $word i32.const 1 i32.add local.set $word br $words_loop
    end end
    local.get $end i32.const 31 i32.and local.tee $remaining_bits
    if
      local.get $count
      local.get $bits local.get $full_words i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $remaining_bits i32.shl i32.const 1 i32.sub i32.and i32.popcnt
      i32.add local.set $count
    end
    local.get $count)

  (func $select1
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $rank i32) (result i32)
    (local $low i32) (local $high i32) (local $mid i32)
    (local $word_index i32) (local $end i32) (local $word i32)
    (local $remaining i32) (local $ones i32)
    local.get $superblocks local.set $high
    block $search_done loop $search_loop
      local.get $low local.get $high i32.ge_u br_if $search_done
      local.get $low local.get $high i32.add i32.const 1 i32.add
      i32.const 1 i32.shr_u local.set $mid
      local.get $rank_index local.get $mid i32.const 2 i32.shl i32.add i32.load
      local.get $rank i32.le_u
      if local.get $mid local.set $low
      else local.get $mid i32.const 1 i32.sub local.set $high end
      br $search_loop
    end end
    local.get $rank
    local.get $rank_index local.get $low i32.const 2 i32.shl i32.add i32.load
    i32.sub local.set $remaining
    local.get $low i32.const 4 i32.shl local.tee $word_index
    i32.const 16 i32.add local.set $end
    local.get $end local.get $padded_words i32.gt_u
    if local.get $padded_words local.set $end end
    block $not_found loop $word_loop
      local.get $word_index local.get $end i32.ge_u br_if $not_found
      local.get $bits local.get $word_index i32.const 2 i32.shl i32.add
      i32.load local.tee $word i32.popcnt local.tee $ones
      local.get $remaining i32.gt_u
      if
        block $selected loop $select_loop
          local.get $remaining i32.eqz br_if $selected
          local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
          local.get $remaining i32.const 1 i32.sub local.set $remaining br $select_loop
        end end
        local.get $word_index i32.const 5 i32.shl
        local.get $word i32.ctz i32.add return
      end
      local.get $remaining local.get $ones i32.sub local.set $remaining
      local.get $word_index i32.const 1 i32.add local.set $word_index br $word_loop
    end end
    i32.const -1)

  (func $select0
    (param $bits i32) (param $rank_index i32) (param $padded_words i32)
    (param $superblocks i32) (param $length i32) (param $rank i32) (result i32)
    (local $low i32) (local $high i32) (local $mid i32) (local $prefix_bits i32)
    (local $zero_prefix i32) (local $remaining i32) (local $word_index i32)
    (local $word_end i32) (local $word i32) (local $zeros i32) (local $valid_bits i32)
    local.get $superblocks local.set $high
    block $search_done loop $search
      local.get $low local.get $high i32.ge_u br_if $search_done
      local.get $low local.get $high i32.add i32.const 1 i32.add
      i32.const 1 i32.shr_u local.set $mid
      local.get $mid i32.const 9 i32.shl local.tee $prefix_bits
      local.get $length i32.gt_u
      if local.get $length local.set $prefix_bits end
      local.get $prefix_bits
      local.get $rank_index local.get $mid i32.const 2 i32.shl i32.add i32.load
      i32.sub local.set $zero_prefix
      local.get $zero_prefix local.get $rank i32.le_u
      if local.get $mid local.set $low
      else local.get $mid i32.const 1 i32.sub local.set $high end
      br $search
    end end
    local.get $low i32.const 9 i32.shl local.tee $prefix_bits
    local.get $length i32.gt_u
    if local.get $length local.set $prefix_bits end
    local.get $rank local.get $prefix_bits
    local.get $rank_index local.get $low i32.const 2 i32.shl i32.add i32.load
    i32.sub i32.sub local.set $remaining
    local.get $low i32.const 4 i32.shl local.set $word_index
    local.get $length i32.const 31 i32.add i32.const 5 i32.shr_u local.set $word_end
    block $not_found loop $word_loop
      local.get $word_index local.get $word_end i32.ge_u br_if $not_found
      local.get $bits local.get $word_index i32.const 2 i32.shl i32.add i32.load
      i32.const -1 i32.xor local.set $word
      local.get $length local.get $word_index i32.const 5 i32.shl i32.sub
      local.tee $valid_bits i32.const 32 i32.lt_u
      if
        local.get $word i32.const 1 local.get $valid_bits i32.shl i32.const 1 i32.sub i32.and
        local.set $word
      end
      local.get $word i32.popcnt local.tee $zeros local.get $remaining i32.gt_u
      if
        block $selected loop $select_loop
          local.get $remaining i32.eqz br_if $selected
          local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
          local.get $remaining i32.const 1 i32.sub local.set $remaining br $select_loop
        end end
        local.get $word_index i32.const 5 i32.shl
        local.get $word i32.ctz i32.add return
      end
      local.get $remaining local.get $zeros i32.sub local.set $remaining
      local.get $word_index i32.const 1 i32.add local.set $word_index br $word_loop
    end end
    i32.const -1)

  (func $low_at (param $low_bits i32) (param $width i32) (param $index i32) (result i32)
    (local $offset i32) (local $word_index i32) (local $shift i32) (local $value i32)
    local.get $width i32.eqz if i32.const 0 return end
    local.get $width i32.const 32 i32.eq
    if local.get $low_bits local.get $index i32.const 2 i32.shl i32.add i32.load return end
    local.get $index local.get $width i32.mul local.tee $offset
    i32.const 5 i32.shr_u local.set $word_index
    local.get $offset i32.const 31 i32.and local.set $shift
    local.get $low_bits local.get $word_index i32.const 2 i32.shl i32.add i32.load
    local.get $shift i32.shr_u local.set $value
    local.get $shift local.get $width i32.add i32.const 32 i32.gt_u
    if
      local.get $value
      local.get $low_bits local.get $word_index i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      i32.const 32 local.get $shift i32.sub i32.shl i32.or local.set $value
    end
    local.get $value i32.const 1 local.get $width i32.shl i32.const 1 i32.sub i32.and)

  (func $at
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $lower_bits i32) (param $index i32)
    (result i32)
    local.get $high_bits local.get $rank_index local.get $padded_words local.get $superblocks
    local.get $index call $select1 local.get $index i32.sub
    local.get $lower_bits i32.shl
    local.get $low_bits local.get $lower_bits local.get $index call $low_at i32.or)

  (func $lower_bound
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $high_length i32)
    (param $length i32) (param $lower_bits i32) (param $zero_count i32) (param $value i32)
    (result i32)
    (local $high i32) (local $low_value i32) (local $start i32) (local $end i32)
    (local $middle i32)
    local.get $length i32.eqz if i32.const 0 return end
    local.get $lower_bits i32.const 32 i32.eq
    if
      i32.const 0 local.set $high
      local.get $value local.set $low_value
    else
      local.get $value local.get $lower_bits i32.shr_u local.set $high
      local.get $lower_bits i32.eqz
      if i32.const 0 local.set $low_value
      else
        local.get $value i32.const 1 local.get $lower_bits i32.shl i32.const 1 i32.sub i32.and
        local.set $low_value
      end
    end
    local.get $high local.get $zero_count i32.gt_u
    if local.get $length return end
    local.get $high i32.eqz
    if i32.const 0 local.set $start
    else
      local.get $high_bits local.get $rank_index local.get $padded_words local.get $superblocks
      local.get $high_length
      local.get $high i32.const 1 i32.sub call $select0
      local.get $high i32.const 1 i32.sub i32.sub local.set $start
    end
    local.get $high local.get $zero_count i32.ge_u
    if local.get $length local.set $end
    else
      local.get $high_bits local.get $rank_index local.get $padded_words local.get $superblocks
      local.get $high_length local.get $high call $select0
      local.get $high i32.sub local.set $end
    end
    block $done loop $search
      local.get $start local.get $end i32.ge_u br_if $done
      local.get $start local.get $end i32.add i32.const 1 i32.shr_u local.set $middle
      local.get $low_bits local.get $lower_bits local.get $middle call $low_at
      local.get $low_value i32.lt_u
      if local.get $middle i32.const 1 i32.add local.set $start
      else local.get $middle local.set $end end
      br $search
    end end
    local.get $start)

  (func (export "at")
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $lower_bits i32) (param $index i32)
    (result i32)
    local.get $high_bits local.get $rank_index local.get $low_bits local.get $padded_words
    local.get $superblocks local.get $lower_bits local.get $index call $at)

  (func (export "lower_bound")
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $high_length i32)
    (param $length i32) (param $lower_bits i32) (param $zero_count i32) (param $value i32)
    (result i32)
    local.get $high_bits local.get $rank_index local.get $low_bits local.get $padded_words
    local.get $superblocks local.get $high_length local.get $length local.get $lower_bits
    local.get $zero_count local.get $value call $lower_bound)

  (func (export "at_many")
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $lower_bits i32)
    (param $indices i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done loop $loop
      local.get $query local.get $count i32.ge_u br_if $done
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $high_bits local.get $rank_index local.get $low_bits local.get $padded_words
      local.get $superblocks local.get $lower_bits
      local.get $indices local.get $query i32.const 2 i32.shl i32.add i32.load
      call $at i32.store
      local.get $query i32.const 1 i32.add local.set $query br $loop
    end end)

  (func (export "lower_bound_many")
    (param $high_bits i32) (param $rank_index i32) (param $low_bits i32)
    (param $padded_words i32) (param $superblocks i32) (param $high_length i32)
    (param $length i32) (param $lower_bits i32) (param $zero_count i32)
    (param $values i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done loop $loop
      local.get $query local.get $count i32.ge_u br_if $done
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $high_bits local.get $rank_index local.get $low_bits local.get $padded_words
      local.get $superblocks local.get $high_length local.get $length local.get $lower_bits
      local.get $zero_count
      local.get $values local.get $query i32.const 2 i32.shl i32.add i32.load
      call $lower_bound i32.store
      local.get $query i32.const 1 i32.add local.set $query br $loop
    end end)

  (func (export "decode_into")
    (param $high_bits i32) (param $low_bits i32) (param $lower_bits i32)
    (param $length i32) (param $output i32)
    (local $index i32) (local $word_index i32) (local $word i32) (local $position i32)
    block $done loop $word_loop
      local.get $index local.get $length i32.ge_u br_if $done
      local.get $high_bits local.get $word_index i32.const 2 i32.shl i32.add i32.load
      local.set $word
      block $next_word loop $bits_loop
        local.get $word i32.eqz br_if $next_word
        local.get $word_index i32.const 5 i32.shl
        local.get $word i32.ctz i32.add local.set $position
        local.get $output local.get $index i32.const 2 i32.shl i32.add
        local.get $position local.get $index i32.sub local.get $lower_bits i32.shl
        local.get $low_bits local.get $lower_bits local.get $index call $low_at i32.or i32.store
        local.get $index i32.const 1 i32.add local.set $index
        local.get $index local.get $length i32.ge_u br_if $done
        local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
        br $bits_loop
      end end
      local.get $word_index i32.const 1 i32.add local.set $word_index br $word_loop
    end end)
)
