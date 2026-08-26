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

  (func $build_rank
    (param $bits i32) (param $ranks i32) (param $padded_words i32) (param $superblocks i32)
    (local $super i32) (local $word i32) (local $end i32) (local $count i32)
    block $done loop $super_loop
      local.get $super local.get $superblocks i32.ge_u br_if $done
      local.get $ranks local.get $super i32.const 2 i32.shl i32.add
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
    local.get $ranks local.get $superblocks i32.const 2 i32.shl i32.add
    local.get $count i32.store)

  (func $level_bits (param $bits i32) (param $padded_words i32) (param $level i32) (result i32)
    local.get $bits
    local.get $level local.get $padded_words i32.mul i32.const 2 i32.shl i32.add)

  (func $level_ranks (param $ranks i32) (param $superblocks i32) (param $level i32) (result i32)
    local.get $ranks
    local.get $level local.get $superblocks i32.const 1 i32.add i32.mul
    i32.const 2 i32.shl i32.add)

  (func $rank1
    (param $bits i32) (param $ranks i32) (param $padded_words i32)
    (param $superblocks i32) (param $level i32) (param $end i32) (result i32)
    (local $level_bits i32) (local $level_ranks i32)
    (local $super i32) (local $word i32) (local $full_words i32)
    (local $remaining_bits i32) (local $count i32)
    local.get $bits local.get $padded_words local.get $level call $level_bits local.set $level_bits
    local.get $ranks local.get $superblocks local.get $level call $level_ranks local.set $level_ranks
    local.get $end i32.const 9 i32.shr_u local.tee $super
    i32.const 4 i32.shl local.set $word
    local.get $level_ranks local.get $super i32.const 2 i32.shl i32.add i32.load
    local.set $count
    local.get $end i32.const 5 i32.shr_u local.set $full_words
    block $vectors_done loop $vectors_loop
      local.get $word i32.const 4 i32.add local.get $full_words i32.gt_u br_if $vectors_done
      local.get $count
      local.get $level_bits local.get $word i32.const 2 i32.shl i32.add v128.load
      call $horizontal_popcount i32.add local.set $count
      local.get $word i32.const 4 i32.add local.set $word br $vectors_loop
    end end
    block $words_done loop $words_loop
      local.get $word local.get $full_words i32.ge_u br_if $words_done
      local.get $count
      local.get $level_bits local.get $word i32.const 2 i32.shl i32.add i32.load i32.popcnt
      i32.add local.set $count
      local.get $word i32.const 1 i32.add local.set $word br $words_loop
    end end
    local.get $end i32.const 31 i32.and local.tee $remaining_bits
    if
      local.get $count
      local.get $level_bits local.get $full_words i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $remaining_bits i32.shl i32.const 1 i32.sub i32.and i32.popcnt
      i32.add local.set $count
    end
    local.get $count)

  (func $bit_at
    (param $bits i32) (param $padded_words i32) (param $level i32) (param $position i32)
    (result i32)
    local.get $bits local.get $padded_words local.get $level call $level_bits
    local.get $position i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add i32.load
    local.get $position i32.const 31 i32.and i32.shr_u i32.const 1 i32.and)

  (func (export "build")
    (param $input i32) (param $scratch i32) (param $bits i32) (param $ranks i32)
    (param $zeros i32) (param $length i32) (param $padded_words i32) (param $superblocks i32)
    (local $level i32) (local $shift i32) (local $current i32) (local $next i32)
    (local $level_bits i32) (local $level_ranks i32)
    (local $index i32) (local $value i32) (local $zero_count i32)
    (local $zero_position i32) (local $one_position i32) (local $swap i32)
    local.get $input local.set $current
    local.get $scratch local.set $next
    block $done loop $level_loop
      local.get $level i32.const 8 i32.ge_u br_if $done
      i32.const 7 local.get $level i32.sub local.set $shift
      local.get $bits local.get $padded_words local.get $level call $level_bits local.set $level_bits
      local.get $ranks local.get $superblocks local.get $level call $level_ranks local.set $level_ranks
      i32.const 0 local.set $index
      i32.const 0 local.set $zero_count
      block $classify_done loop $classify
        local.get $index local.get $length i32.ge_u br_if $classify_done
        local.get $current local.get $index i32.const 2 i32.shl i32.add i32.load local.set $value
        local.get $value local.get $shift i32.shr_u i32.const 1 i32.and
        if
          local.get $level_bits
          local.get $index i32.const 5 i32.shr_u i32.const 2 i32.shl i32.add
          local.tee $swap local.get $swap i32.load
          i32.const 1 local.get $index i32.const 31 i32.and i32.shl i32.or i32.store
        else
          local.get $zero_count i32.const 1 i32.add local.set $zero_count
        end
        local.get $index i32.const 1 i32.add local.set $index br $classify
      end end
      local.get $zeros local.get $level i32.const 2 i32.shl i32.add
      local.get $zero_count i32.store
      i32.const 0 local.set $zero_position
      local.get $zero_count local.set $one_position
      i32.const 0 local.set $index
      block $partition_done loop $partition
        local.get $index local.get $length i32.ge_u br_if $partition_done
        local.get $current local.get $index i32.const 2 i32.shl i32.add i32.load local.set $value
        local.get $value local.get $shift i32.shr_u i32.const 1 i32.and
        if
          local.get $next local.get $one_position i32.const 2 i32.shl i32.add
          local.get $value i32.store
          local.get $one_position i32.const 1 i32.add local.set $one_position
        else
          local.get $next local.get $zero_position i32.const 2 i32.shl i32.add
          local.get $value i32.store
          local.get $zero_position i32.const 1 i32.add local.set $zero_position
        end
        local.get $index i32.const 1 i32.add local.set $index br $partition
      end end
      local.get $level_bits local.get $level_ranks local.get $padded_words local.get $superblocks
      call $build_rank
      local.get $current local.set $swap
      local.get $next local.set $current
      local.get $swap local.set $next
      local.get $level i32.const 1 i32.add local.set $level br $level_loop
    end end)

  (func $access
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32) (param $index i32) (result i32)
    (local $level i32) (local $position i32) (local $bit i32) (local $result i32)
    local.get $index local.set $position
    block $done loop $loop
      local.get $level i32.const 8 i32.ge_u br_if $done
      local.get $bits local.get $padded_words local.get $level local.get $position
      call $bit_at local.tee $bit
      if
        local.get $result i32.const 1 i32.const 7 local.get $level i32.sub i32.shl
        i32.or local.set $result
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
        local.get $level local.get $position call $rank1 i32.add local.set $position
      else
        local.get $position
        local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
        local.get $level local.get $position call $rank1 i32.sub local.set $position
      end
      local.get $level i32.const 1 i32.add local.set $level br $loop
    end end
    local.get $result)

  (func $rank
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32) (param $value i32) (param $end i32)
    (result i32)
    (local $level i32) (local $left i32) (local $right i32)
    (local $left_ones i32) (local $right_ones i32)
    local.get $end local.set $right
    block $done loop $loop
      local.get $level i32.const 8 i32.ge_u br_if $done
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $left call $rank1 local.set $left_ones
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $right call $rank1 local.set $right_ones
      local.get $value i32.const 7 local.get $level i32.sub i32.shr_u i32.const 1 i32.and
      if
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $left_ones i32.add local.set $left
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $right_ones i32.add local.set $right
      else
        local.get $left local.get $left_ones i32.sub local.set $left
        local.get $right local.get $right_ones i32.sub local.set $right
      end
      local.get $level i32.const 1 i32.add local.set $level br $loop
    end end
    local.get $right local.get $left i32.sub)

  (func $count_lt
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $left_start i32) (param $right_start i32) (param $value i32) (result i32)
    (local $level i32) (local $left i32) (local $right i32)
    (local $left_ones i32) (local $right_ones i32) (local $count i32)
    local.get $left_start local.set $left
    local.get $right_start local.set $right
    block $done loop $loop
      local.get $level i32.const 8 i32.ge_u br_if $done
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $left call $rank1 local.set $left_ones
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $right call $rank1 local.set $right_ones
      local.get $value i32.const 7 local.get $level i32.sub i32.shr_u i32.const 1 i32.and
      if
        local.get $count
        local.get $right local.get $right_ones i32.sub
        local.get $left local.get $left_ones i32.sub i32.sub i32.add local.set $count
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $left_ones i32.add local.set $left
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $right_ones i32.add local.set $right
      else
        local.get $left local.get $left_ones i32.sub local.set $left
        local.get $right local.get $right_ones i32.sub local.set $right
      end
      local.get $level i32.const 1 i32.add local.set $level br $loop
    end end
    local.get $count)

  (func $quantile
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $left_start i32) (param $right_start i32) (param $kth_start i32) (result i32)
    (local $level i32) (local $left i32) (local $right i32) (local $kth i32)
    (local $left_ones i32) (local $right_ones i32) (local $zero_count i32)
    (local $result i32)
    local.get $left_start local.set $left
    local.get $right_start local.set $right
    local.get $kth_start local.set $kth
    block $done loop $loop
      local.get $level i32.const 8 i32.ge_u br_if $done
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $left call $rank1 local.set $left_ones
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $right call $rank1 local.set $right_ones
      local.get $right local.get $right_ones i32.sub
      local.get $left local.get $left_ones i32.sub i32.sub local.set $zero_count
      local.get $kth local.get $zero_count i32.lt_u
      if
        local.get $left local.get $left_ones i32.sub local.set $left
        local.get $right local.get $right_ones i32.sub local.set $right
      else
        local.get $result i32.const 1 i32.const 7 local.get $level i32.sub i32.shl
        i32.or local.set $result
        local.get $kth local.get $zero_count i32.sub local.set $kth
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $left_ones i32.add local.set $left
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $right_ones i32.add local.set $right
      end
      local.get $level i32.const 1 i32.add local.set $level br $loop
    end end
    local.get $result)

  (func $select_bit
    (param $bits i32) (param $ranks i32) (param $padded_words i32) (param $superblocks i32)
    (param $level i32) (param $length i32) (param $bit i32) (param $target i32) (result i32)
    (local $low i32) (local $high i32) (local $mid i32) (local $ones i32) (local $count i32)
    local.get $length local.set $high
    block $done loop $search
      local.get $low local.get $high i32.ge_u br_if $done
      local.get $low local.get $high i32.add i32.const 1 i32.shr_u local.set $mid
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $mid i32.const 1 i32.add call $rank1 local.set $ones
      local.get $bit
      if local.get $ones local.set $count
      else local.get $mid i32.const 1 i32.add local.get $ones i32.sub local.set $count end
      local.get $count local.get $target i32.gt_u
      if local.get $mid local.set $high
      else local.get $mid i32.const 1 i32.add local.set $low end
      br $search
    end end
    local.get $low)

  (func (export "select")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32) (param $length i32)
    (param $value i32) (param $occurrence i32) (result i32)
    (local $level i32) (local $left i32) (local $right i32)
    (local $left_ones i32) (local $right_ones i32) (local $bit i32) (local $position i32)
    local.get $length local.set $right
    block $forward_done loop $forward
      local.get $level i32.const 8 i32.ge_u br_if $forward_done
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $left call $rank1 local.set $left_ones
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $right call $rank1 local.set $right_ones
      local.get $value i32.const 7 local.get $level i32.sub i32.shr_u i32.const 1 i32.and local.set $bit
      local.get $bit
      if
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $left_ones i32.add local.set $left
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load
        local.get $right_ones i32.add local.set $right
      else
        local.get $left local.get $left_ones i32.sub local.set $left
        local.get $right local.get $right_ones i32.sub local.set $right
      end
      local.get $level i32.const 1 i32.add local.set $level br $forward
    end end
    local.get $occurrence local.get $right local.get $left i32.sub i32.ge_u
    if i32.const -1 return end
    local.get $left local.get $occurrence i32.add local.set $position
    i32.const 8 local.set $level
    block $reverse_done loop $reverse
      local.get $level i32.eqz br_if $reverse_done
      local.get $level i32.const 1 i32.sub local.set $level
      local.get $value i32.const 7 local.get $level i32.sub i32.shr_u i32.const 1 i32.and local.set $bit
      local.get $bit
      if
        local.get $position
        local.get $zeros local.get $level i32.const 2 i32.shl i32.add i32.load i32.sub
        local.set $position
      end
      local.get $bits local.get $ranks local.get $padded_words local.get $superblocks
      local.get $level local.get $length local.get $bit local.get $position call $select_bit
      local.set $position
      br $reverse
    end end
    local.get $position)

  (func (export "access")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32) (param $index i32) (result i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $index call $access)

  (func (export "rank")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32) (param $value i32) (param $end i32)
    (result i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $value local.get $end call $rank)

  (func (export "count_lt")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $left i32) (param $right i32) (param $value i32) (result i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $left local.get $right local.get $value call $count_lt)

  (func (export "quantile")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $left i32) (param $right i32) (param $kth i32) (result i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $left local.get $right local.get $kth call $quantile)

  (func (export "access_many")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $indices i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done loop $loop
      local.get $query local.get $count i32.ge_u br_if $done
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words local.get $superblocks
      local.get $indices local.get $query i32.const 2 i32.shl i32.add i32.load
      call $access i32.store
      local.get $query i32.const 1 i32.add local.set $query br $loop
    end end)

  (func (export "rank_many")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $values i32) (param $ends i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done loop $loop
      local.get $query local.get $count i32.ge_u br_if $done
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words local.get $superblocks
      local.get $values local.get $query i32.const 2 i32.shl i32.add i32.load
      local.get $ends local.get $query i32.const 2 i32.shl i32.add i32.load
      call $rank i32.store
      local.get $query i32.const 1 i32.add local.set $query br $loop
    end end)

  (func (export "quantile_many")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $lefts i32) (param $rights i32) (param $kths i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done loop $loop
      local.get $query local.get $count i32.ge_u br_if $done
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words local.get $superblocks
      local.get $lefts local.get $query i32.const 2 i32.shl i32.add i32.load
      local.get $rights local.get $query i32.const 2 i32.shl i32.add i32.load
      local.get $kths local.get $query i32.const 2 i32.shl i32.add i32.load
      call $quantile i32.store
      local.get $query i32.const 1 i32.add local.set $query br $loop
    end end)

  (func $occ
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $sentinel_row i32) (param $value i32) (param $end i32) (result i32)
    (local $count i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $value local.get $end call $rank local.set $count
    local.get $value i32.eqz
    local.get $sentinel_row local.get $end i32.lt_u i32.and
    if local.get $count i32.const 1 i32.sub local.set $count end
    local.get $count)

  (func $count_pattern
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $text_length i32)
    (param $pattern i32) (param $pattern_length i32) (result i32)
    (local $index i32) (local $value i32) (local $base i32)
    (local $left i32) (local $right i32)
    local.get $text_length i32.const 1 i32.add local.set $right
    local.get $pattern_length local.set $index
    block $done loop $loop
      local.get $index i32.eqz br_if $done
      local.get $index i32.const 1 i32.sub local.tee $index
      local.get $pattern i32.add i32.load8_u local.tee $value
      i32.const 2 i32.shl local.get $cumulative i32.add i32.load local.set $base
      local.get $base
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words
      local.get $superblocks local.get $sentinel_row local.get $value local.get $left call $occ
      i32.add local.set $left
      local.get $base
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words
      local.get $superblocks local.get $sentinel_row local.get $value local.get $right call $occ
      i32.add local.set $right
      local.get $left local.get $right i32.ge_u
      if i32.const 0 return end
      br $loop
    end end
    local.get $right local.get $left i32.sub)

  (func (export "count")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $text_length i32)
    (param $pattern i32) (param $pattern_length i32) (result i32)
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $cumulative local.get $sentinel_row local.get $text_length
    local.get $pattern local.get $pattern_length call $count_pattern)

  (func (export "count_many")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $text_length i32)
    (param $patterns i32) (param $offsets i32) (param $query_count i32) (param $output i32)
    (local $query i32) (local $start i32) (local $length i32)
    block $done loop $loop
      local.get $query local.get $query_count i32.ge_u br_if $done
      local.get $offsets local.get $query i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $offsets local.get $query i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.set $length
      local.get $output local.get $query i32.const 2 i32.shl i32.add
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words
      local.get $superblocks local.get $cumulative local.get $sentinel_row local.get $text_length
      local.get $patterns local.get $start i32.add local.get $length call $count_pattern i32.store
      local.get $query i32.const 1 i32.add local.set $query
      br $loop
    end end)

  (func $lf
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $row i32) (result i32)
    (local $value i32)
    local.get $row local.get $sentinel_row i32.eq
    if i32.const 0 return end
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $row call $access local.tee $value
    i32.const 2 i32.shl local.get $cumulative i32.add i32.load
    local.get $bits local.get $ranks local.get $zeros local.get $padded_words
    local.get $superblocks local.get $sentinel_row local.get $value local.get $row call $occ
    i32.add)

  (func $locate_row
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $text_length i32)
    (param $sample_bits i32) (param $sample_ranks i32) (param $sample_values i32)
    (param $row_start i32) (result i32)
    (local $row i32) (local $steps i32) (local $sample_index i32) (local $position i32)
    local.get $row_start local.set $row
    block $found loop $loop
      local.get $sample_bits local.get $padded_words i32.const 0 local.get $row call $bit_at
      br_if $found
      local.get $bits local.get $ranks local.get $zeros local.get $padded_words
      local.get $superblocks local.get $cumulative local.get $sentinel_row local.get $row call $lf
      local.set $row
      local.get $steps i32.const 1 i32.add local.set $steps
      br $loop
    end end
    local.get $sample_bits local.get $sample_ranks local.get $padded_words local.get $superblocks
    i32.const 0 local.get $row call $rank1 local.set $sample_index
    local.get $sample_values local.get $sample_index i32.const 2 i32.shl i32.add i32.load
    local.get $steps i32.add local.set $position
    local.get $position local.get $text_length i32.gt_u
    if local.get $position local.get $text_length i32.const 1 i32.add i32.sub local.set $position end
    local.get $position)

  (func (export "locate_many")
    (param $bits i32) (param $ranks i32) (param $zeros i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $cumulative i32) (param $sentinel_row i32) (param $text_length i32)
    (param $sample_bits i32) (param $sample_ranks i32) (param $sample_values i32)
    (param $patterns i32) (param $offsets i32) (param $query_count i32)
    (param $result_offsets i32) (param $output i32)
    (local $query i32) (local $index i32) (local $start i32) (local $length i32)
    (local $value i32) (local $base i32) (local $left i32) (local $right i32)
    (local $row i32) (local $output_index i32)
    block $queries_done loop $queries
      local.get $query local.get $query_count i32.ge_u br_if $queries_done
      local.get $offsets local.get $query i32.const 2 i32.shl i32.add i32.load local.set $start
      local.get $offsets local.get $query i32.const 1 i32.add i32.const 2 i32.shl i32.add i32.load
      local.get $start i32.sub local.tee $length local.set $index
      i32.const 0 local.set $left
      local.get $text_length i32.const 1 i32.add local.set $right
      block $search_done loop $search
        local.get $index i32.eqz br_if $search_done
        local.get $index i32.const 1 i32.sub local.tee $index
        local.get $patterns local.get $start i32.add i32.add i32.load8_u local.tee $value
        i32.const 2 i32.shl local.get $cumulative i32.add i32.load local.set $base
        local.get $base
        local.get $bits local.get $ranks local.get $zeros local.get $padded_words
        local.get $superblocks local.get $sentinel_row local.get $value local.get $left call $occ
        i32.add local.set $left
        local.get $base
        local.get $bits local.get $ranks local.get $zeros local.get $padded_words
        local.get $superblocks local.get $sentinel_row local.get $value local.get $right call $occ
        i32.add local.set $right
        local.get $left local.get $right i32.ge_u br_if $search_done
        br $search
      end end
      local.get $left local.set $row
      local.get $result_offsets local.get $query i32.const 2 i32.shl i32.add i32.load
      local.set $output_index
      block $rows_done loop $rows
        local.get $row local.get $right i32.ge_u br_if $rows_done
        local.get $output local.get $output_index i32.const 2 i32.shl i32.add
        local.get $bits local.get $ranks local.get $zeros local.get $padded_words
        local.get $superblocks local.get $cumulative local.get $sentinel_row local.get $text_length
        local.get $sample_bits local.get $sample_ranks local.get $sample_values local.get $row
        call $locate_row i32.store
        local.get $row i32.const 1 i32.add local.set $row
        local.get $output_index i32.const 1 i32.add local.set $output_index
        br $rows
      end end
      local.get $query i32.const 1 i32.add local.set $query
      br $queries
    end end)
)
