(module
  (import "jsimd" "memory" (memory 1 65536 shared))

  (func (export "fill_u32") (param $pointer i32) (param $length i32) (param $value i32)
    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 4
        i32.lt_u
        br_if $simd_done

        local.get $pointer
        local.get $value
        i32x4.splat
        v128.store align=4

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

    (block $scalar_done
      (loop $scalar
        local.get $length
        i32.eqz
        br_if $scalar_done

        local.get $pointer
        local.get $value
        i32.store align=4

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
  )

  (func (export "copy_bytes") (param $destination i32) (param $source i32) (param $length i32)
    (block $simd_done
      (loop $simd
        local.get $length
        i32.const 16
        i32.lt_u
        br_if $simd_done

        local.get $destination
        local.get $source
        v128.load
        v128.store

        local.get $destination
        i32.const 16
        i32.add
        local.set $destination
        local.get $source
        i32.const 16
        i32.add
        local.set $source
        local.get $length
        i32.const 16
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

        local.get $destination
        local.get $source
        i32.load8_u
        i32.store8

        local.get $destination
        i32.const 1
        i32.add
        local.set $destination
        local.get $source
        i32.const 1
        i32.add
        local.set $source
        local.get $length
        i32.const 1
        i32.sub
        local.set $length
        br $scalar
      )
    )
  )

  (func (export "reduce_shards_or")
    (param $destination i32)
    (param $source i32)
    (param $shard_count i32)
    (param $shard_stride i32)
    (param $words i32)
    (local $word i32)
    (local $shard i32)
    (local $accumulator v128)

    (block $words_done
      (loop $words_loop
        local.get $word
        local.get $words
        i32.ge_u
        br_if $words_done

        v128.const i32x4 0 0 0 0
        local.set $accumulator
        i32.const 0
        local.set $shard

        (block $shards_done
          (loop $shards_loop
            local.get $shard
            local.get $shard_count
            i32.ge_u
            br_if $shards_done

            local.get $accumulator
            local.get $source
            local.get $shard
            local.get $shard_stride
            i32.mul
            i32.add
            local.get $word
            i32.const 4
            i32.mul
            i32.add
            v128.load align=4
            v128.or
            local.set $accumulator

            local.get $shard
            i32.const 1
            i32.add
            local.set $shard
            br $shards_loop
          )
        )

        local.get $destination
        local.get $word
        i32.const 4
        i32.mul
        i32.add
        local.get $accumulator
        v128.store align=4

        local.get $word
        i32.const 4
        i32.add
        local.set $word
        br $words_loop
      )
    )
  )

  (func (export "reduce_shards_and")
    (param $destination i32)
    (param $source i32)
    (param $shard_count i32)
    (param $shard_stride i32)
    (param $words i32)
    (local $word i32)
    (local $shard i32)
    (local $accumulator v128)

    (block $words_done
      (loop $words_loop
        local.get $word
        local.get $words
        i32.ge_u
        br_if $words_done

        v128.const i32x4 -1 -1 -1 -1
        local.set $accumulator
        i32.const 0
        local.set $shard

        (block $shards_done
          (loop $shards_loop
            local.get $shard
            local.get $shard_count
            i32.ge_u
            br_if $shards_done

            local.get $accumulator
            local.get $source
            local.get $shard
            local.get $shard_stride
            i32.mul
            i32.add
            local.get $word
            i32.const 4
            i32.mul
            i32.add
            v128.load align=4
            v128.and
            local.set $accumulator

            local.get $shard
            i32.const 1
            i32.add
            local.set $shard
            br $shards_loop
          )
        )

        local.get $destination
        local.get $word
        i32.const 4
        i32.mul
        i32.add
        local.get $accumulator
        v128.store align=4

        local.get $word
        i32.const 4
        i32.add
        local.set $word
        br $words_loop
      )
    )
  )

  (func (export "reduce_shards_sum_u32")
    (param $destination i32)
    (param $source i32)
    (param $shard_count i32)
    (param $shard_stride i32)
    (param $words i32)
    (local $word i32)
    (local $shard i32)
    (local $accumulator v128)

    (block $words_done
      (loop $words_loop
        local.get $word
        local.get $words
        i32.ge_u
        br_if $words_done

        v128.const i32x4 0 0 0 0
        local.set $accumulator
        i32.const 0
        local.set $shard

        (block $shards_done
          (loop $shards_loop
            local.get $shard
            local.get $shard_count
            i32.ge_u
            br_if $shards_done

            local.get $accumulator
            local.get $source
            local.get $shard
            local.get $shard_stride
            i32.mul
            i32.add
            local.get $word
            i32.const 4
            i32.mul
            i32.add
            v128.load align=4
            i32x4.add
            local.set $accumulator

            local.get $shard
            i32.const 1
            i32.add
            local.set $shard
            br $shards_loop
          )
        )

        local.get $destination
        local.get $word
        i32.const 4
        i32.mul
        i32.add
        local.get $accumulator
        v128.store align=4

        local.get $word
        i32.const 4
        i32.add
        local.set $word
        br $words_loop
      )
    )
  )
)
