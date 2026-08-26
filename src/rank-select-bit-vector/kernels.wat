(module
  (memory (export "memory") 1)

  (func $horizontal_popcount (param $value v128) (result i32)
    (local $lanes v128)
    local.get $value i8x16.popcnt i16x8.extadd_pairwise_i8x16_u
    i32x4.extadd_pairwise_i16x8_u local.set $lanes
    local.get $lanes i32x4.extract_lane 0
    local.get $lanes i32x4.extract_lane 1 i32.add
    local.get $lanes i32x4.extract_lane 2 i32.add
    local.get $lanes i32x4.extract_lane 3 i32.add
  )

  ;; Store one cumulative count per 512-bit (16-word) superblock.
  (func (export "build_rank_index")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (result i32)
    (local $super i32) (local $word i32) (local $end i32) (local $count i32)
    block $done
      loop $super_loop
        local.get $super local.get $superblocks i32.ge_u br_if $done
        local.get $rank_index local.get $super i32.const 2 i32.shl i32.add
        local.get $count i32.store
        local.get $super i32.const 4 i32.shl local.tee $word
        i32.const 16 i32.add local.set $end
        local.get $end local.get $padded_words i32.gt_u
        if local.get $padded_words local.set $end end
        block $words_done
          loop $words_loop
            local.get $word local.get $end i32.ge_u br_if $words_done
            local.get $count
            local.get $bits local.get $word i32.const 2 i32.shl i32.add v128.load
            call $horizontal_popcount i32.add local.set $count
            local.get $word i32.const 4 i32.add local.set $word br $words_loop
          end
        end
        local.get $super i32.const 1 i32.add local.set $super br $super_loop
      end
    end
    local.get $rank_index local.get $superblocks i32.const 2 i32.shl i32.add
    local.get $count i32.store
    local.get $count
  )

  (func $rank1 (export "rank1")
    (param $bits i32) (param $rank_index i32) (param $end i32) (result i32)
    (local $super i32) (local $word i32) (local $full_words i32)
    (local $remaining_bits i32) (local $count i32)
    local.get $end i32.const 9 i32.shr_u local.tee $super
    i32.const 4 i32.shl local.set $word
    local.get $rank_index local.get $super i32.const 2 i32.shl i32.add
    i32.load local.set $count
    local.get $end i32.const 5 i32.shr_u local.set $full_words
    block $vectors_done
      loop $vectors_loop
        local.get $word i32.const 4 i32.add local.get $full_words i32.gt_u br_if $vectors_done
        local.get $count
        local.get $bits local.get $word i32.const 2 i32.shl i32.add v128.load
        call $horizontal_popcount i32.add local.set $count
        local.get $word i32.const 4 i32.add local.set $word br $vectors_loop
      end
    end
    block $words_done
      loop $words_loop
        local.get $word local.get $full_words i32.ge_u br_if $words_done
        local.get $count
        local.get $bits local.get $word i32.const 2 i32.shl i32.add i32.load i32.popcnt
        i32.add local.set $count
        local.get $word i32.const 1 i32.add local.set $word br $words_loop
      end
    end
    local.get $end i32.const 31 i32.and local.tee $remaining_bits
    if
      local.get $count
      local.get $bits local.get $full_words i32.const 2 i32.shl i32.add i32.load
      i32.const 1 local.get $remaining_bits i32.shl i32.const 1 i32.sub i32.and i32.popcnt
      i32.add local.set $count
    end
    local.get $count
  )

  (func $rank0 (param $bits i32) (param $rank_index i32) (param $end i32) (result i32)
    local.get $end
    local.get $bits local.get $rank_index local.get $end call $rank1
    i32.sub
  )

  (func $select1 (export "select1")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $rank i32) (result i32)
    (local $low i32) (local $high i32) (local $mid i32)
    (local $word_index i32) (local $end i32) (local $word i32)
    (local $remaining i32) (local $ones i32)
    local.get $superblocks local.set $high
    block $search_done
      loop $search_loop
        local.get $low local.get $high i32.ge_u br_if $search_done
        local.get $low local.get $high i32.add i32.const 1 i32.add
        i32.const 1 i32.shr_u local.set $mid
        local.get $rank_index local.get $mid i32.const 2 i32.shl i32.add i32.load
        local.get $rank i32.le_u
        if
          local.get $mid local.set $low
        else
          local.get $mid i32.const 1 i32.sub local.set $high
        end
        br $search_loop
      end
    end
    local.get $rank
    local.get $rank_index local.get $low i32.const 2 i32.shl i32.add i32.load
    i32.sub local.set $remaining
    local.get $low i32.const 4 i32.shl local.tee $word_index
    i32.const 16 i32.add local.set $end
    local.get $end local.get $padded_words i32.gt_u
    if local.get $padded_words local.set $end end
    block $not_found
      loop $word_loop
        local.get $word_index local.get $end i32.ge_u br_if $not_found
        local.get $bits local.get $word_index i32.const 2 i32.shl i32.add
        i32.load local.tee $word i32.popcnt local.tee $ones
        local.get $remaining i32.gt_u
        if
          block $selected
            loop $select_loop
              local.get $remaining i32.eqz br_if $selected
              local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
              local.get $remaining i32.const 1 i32.sub local.set $remaining
              br $select_loop
            end
          end
          local.get $word_index i32.const 5 i32.shl
          local.get $word i32.ctz i32.add return
        end
        local.get $remaining local.get $ones i32.sub local.set $remaining
        local.get $word_index i32.const 1 i32.add local.set $word_index
        br $word_loop
      end
    end
    i32.const -1
  )

  (func $select0 (export "select0")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $length i32) (param $rank i32) (result i32)
    (local $low i32) (local $high i32) (local $mid i32)
    (local $boundary i32) (local $zeros i32)
    (local $word_index i32) (local $end i32) (local $valid_bits i32)
    (local $word i32) (local $remaining i32) (local $count i32)
    local.get $superblocks local.set $high
    block $search_done
      loop $search_loop
        local.get $low local.get $high i32.ge_u br_if $search_done
        local.get $low local.get $high i32.add i32.const 1 i32.add
        i32.const 1 i32.shr_u local.set $mid
        local.get $mid i32.const 9 i32.shl local.tee $boundary
        local.get $length i32.gt_u
        if local.get $length local.set $boundary end
        local.get $boundary
        local.get $rank_index local.get $mid i32.const 2 i32.shl i32.add i32.load
        i32.sub local.set $zeros
        local.get $zeros local.get $rank i32.le_u
        if
          local.get $mid local.set $low
        else
          local.get $mid i32.const 1 i32.sub local.set $high
        end
        br $search_loop
      end
    end
    local.get $low i32.const 9 i32.shl local.tee $boundary
    local.get $length i32.gt_u
    if local.get $length local.set $boundary end
    local.get $rank
    local.get $boundary
    local.get $rank_index local.get $low i32.const 2 i32.shl i32.add i32.load
    i32.sub i32.sub local.set $remaining
    local.get $low i32.const 4 i32.shl local.tee $word_index
    i32.const 16 i32.add local.set $end
    local.get $end local.get $padded_words i32.gt_u
    if local.get $padded_words local.set $end end
    block $not_found
      loop $word_loop
        local.get $word_index local.get $end i32.ge_u br_if $not_found
        local.get $length local.get $word_index i32.const 5 i32.shl
        i32.sub local.tee $valid_bits i32.const 0 i32.le_s br_if $not_found
        local.get $bits local.get $word_index i32.const 2 i32.shl i32.add
        i32.load i32.const -1 i32.xor local.set $word
        local.get $valid_bits i32.const 32 i32.lt_u
        if
          local.get $word
          i32.const 1 local.get $valid_bits i32.shl i32.const 1 i32.sub i32.and
          local.set $word
        end
        local.get $word i32.popcnt local.tee $count
        local.get $remaining i32.gt_u
        if
          block $selected
            loop $select_loop
              local.get $remaining i32.eqz br_if $selected
              local.get $word local.get $word i32.const 1 i32.sub i32.and local.set $word
              local.get $remaining i32.const 1 i32.sub local.set $remaining
              br $select_loop
            end
          end
          local.get $word_index i32.const 5 i32.shl
          local.get $word i32.ctz i32.add return
        end
        local.get $remaining local.get $count i32.sub local.set $remaining
        local.get $word_index i32.const 1 i32.add local.set $word_index
        br $word_loop
      end
    end
    i32.const -1
  )

  (func (export "rank1_many")
    (param $bits i32) (param $rank_index i32)
    (param $ends i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done
      loop $loop
        local.get $query local.get $count i32.ge_u br_if $done
        local.get $output local.get $query i32.const 2 i32.shl i32.add
        local.get $bits local.get $rank_index
        local.get $ends local.get $query i32.const 2 i32.shl i32.add i32.load
        call $rank1 i32.store
        local.get $query i32.const 1 i32.add local.set $query br $loop
      end
    end
  )

  (func (export "rank0_many")
    (param $bits i32) (param $rank_index i32)
    (param $ends i32) (param $output i32) (param $count i32)
    (local $query i32) (local $end i32)
    block $done
      loop $loop
        local.get $query local.get $count i32.ge_u br_if $done
        local.get $ends local.get $query i32.const 2 i32.shl i32.add
        i32.load local.set $end
        local.get $output local.get $query i32.const 2 i32.shl i32.add
        local.get $bits local.get $rank_index local.get $end call $rank0 i32.store
        local.get $query i32.const 1 i32.add local.set $query br $loop
      end
    end
  )

  (func (export "select1_many")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32)
    (param $ranks i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done
      loop $loop
        local.get $query local.get $count i32.ge_u br_if $done
        local.get $output local.get $query i32.const 2 i32.shl i32.add
        local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
        local.get $ranks local.get $query i32.const 2 i32.shl i32.add i32.load
        call $select1 i32.store
        local.get $query i32.const 1 i32.add local.set $query br $loop
      end
    end
  )

  (func (export "select0_many")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $length i32)
    (param $ranks i32) (param $output i32) (param $count i32)
    (local $query i32)
    block $done
      loop $loop
        local.get $query local.get $count i32.ge_u br_if $done
        local.get $output local.get $query i32.const 2 i32.shl i32.add
        local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
        local.get $length
        local.get $ranks local.get $query i32.const 2 i32.shl i32.add i32.load
        call $select0 i32.store
        local.get $query i32.const 1 i32.add local.set $query br $loop
      end
    end
  )

  (func (export "next1")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $count_ones i32)
    (param $length i32) (param $position i32) (result i32)
    (local $rank i32)
    local.get $position i32.const 0 i32.lt_s
    if i32.const 0 local.set $position end
    local.get $position local.get $length i32.ge_u
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $position call $rank1 local.tee $rank
    local.get $count_ones i32.ge_u
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
    local.get $rank call $select1
  )

  (func (export "prev1")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $count_ones i32)
    (param $length i32) (param $position i32) (result i32)
    (local $rank i32)
    local.get $position i32.const 0 i32.lt_s
    if i32.const -1 return end
    local.get $length i32.eqz
    if i32.const -1 return end
    local.get $position local.get $length i32.ge_u
    if local.get $length i32.const 1 i32.sub local.set $position end
    local.get $bits local.get $rank_index local.get $position i32.const 1 i32.add
    call $rank1 local.tee $rank i32.eqz
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
    local.get $rank i32.const 1 i32.sub call $select1
  )

  (func (export "next0")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $count_zeros i32)
    (param $length i32) (param $position i32) (result i32)
    (local $rank i32)
    local.get $position i32.const 0 i32.lt_s
    if i32.const 0 local.set $position end
    local.get $position local.get $length i32.ge_u
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $position call $rank0 local.tee $rank
    local.get $count_zeros i32.ge_u
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
    local.get $length local.get $rank call $select0
  )

  (func (export "prev0")
    (param $bits i32) (param $rank_index i32)
    (param $padded_words i32) (param $superblocks i32) (param $count_zeros i32)
    (param $length i32) (param $position i32) (result i32)
    (local $rank i32)
    local.get $position i32.const 0 i32.lt_s
    if i32.const -1 return end
    local.get $length i32.eqz
    if i32.const -1 return end
    local.get $position local.get $length i32.ge_u
    if local.get $length i32.const 1 i32.sub local.set $position end
    local.get $bits local.get $rank_index local.get $position i32.const 1 i32.add
    call $rank0 local.tee $rank i32.eqz
    if i32.const -1 return end
    local.get $bits local.get $rank_index local.get $padded_words local.get $superblocks
    local.get $length local.get $rank i32.const 1 i32.sub call $select0
  )
)
