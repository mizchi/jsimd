(module
  (memory (export "memory") 1)

  (func $mix (param $value i32) (result i32)
    (local $hash i32)
    local.get $value local.get $value i32.const 16 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x7feb352d i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 15 i32.shr_u i32.xor local.set $hash
    local.get $hash i32.const 0x846ca68b i32.mul local.set $hash
    local.get $hash local.get $hash i32.const 16 i32.shr_u i32.xor
  )

  (func $mix4 (param $values v128) (result v128)
    (local $hash v128)
    local.get $values local.get $values i32.const 16 i32x4.shr_u v128.xor local.set $hash
    local.get $hash i32.const 0x7feb352d i32x4.splat i32x4.mul local.set $hash
    local.get $hash local.get $hash i32.const 15 i32x4.shr_u v128.xor local.set $hash
    local.get $hash i32.const 0x846ca68b i32x4.splat i32x4.mul local.set $hash
    local.get $hash local.get $hash i32.const 16 i32x4.shr_u v128.xor
  )

  (func $lookup_hashed
    (param $displacements i32) (param $fingerprints i32)
    (param $bucket_count i32) (param $length i32) (param $key i32) (param $first_hash i32)
    (result i32)
    (local $bucket i32) (local $displacement i32) (local $slot i32) (local $fingerprint i32)
    local.get $length i32.eqz if i32.const -1 return end
    local.get $first_hash local.get $bucket_count i32.rem_u local.set $bucket
    local.get $displacements local.get $bucket i32.const 2 i32.shl i32.add i32.load
    local.tee $displacement i32.const 0x80000000 i32.eq
    if i32.const -1 return end
    local.get $displacement i32.const 0 i32.lt_s
    if
      i32.const -1 local.get $displacement i32.sub local.set $slot
    else
      local.get $key local.get $displacement i32.const 0x9e3779b9 i32.mul i32.xor
      call $mix local.get $length i32.rem_u local.set $slot
    end
    local.get $key i32.const 0xa5a5a5a5 i32.xor call $mix i32.const 0xffff i32.and
    local.set $fingerprint
    local.get $fingerprints local.get $slot i32.const 1 i32.shl i32.add i32.load16_u
    local.get $fingerprint i32.ne if i32.const -1 return end
    local.get $slot
  )

  (func $lookup (export "lookup")
    (param $displacements i32) (param $fingerprints i32)
    (param $bucket_count i32) (param $length i32) (param $key i32) (result i32)
    local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
    local.get $key local.get $key call $mix call $lookup_hashed
  )

  (func (export "lookup_many")
    (param $displacements i32) (param $fingerprints i32)
    (param $bucket_count i32) (param $length i32)
    (param $queries i32) (param $query_count i32) (param $output i32) (result i32)
    (local $index i32) (local $end4 i32) (local $keys v128) (local $hashes v128)
    (local $slot i32) (local $found i32)
    local.get $query_count i32.const -4 i32.and local.set $end4
    block $vectors_done loop $vectors
      local.get $index local.get $end4 i32.ge_u br_if $vectors_done
      local.get $queries local.get $index i32.const 2 i32.shl i32.add v128.load local.tee $keys
      call $mix4 local.set $hashes

      local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
      local.get $keys i32x4.extract_lane 0 local.get $hashes i32x4.extract_lane 0
      call $lookup_hashed local.tee $slot
      local.get $output local.get $index i32.const 2 i32.shl i32.add local.get $slot i32.store
      local.get $found local.get $slot i32.const 0 i32.ge_s i32.add local.set $found

      local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
      local.get $keys i32x4.extract_lane 1 local.get $hashes i32x4.extract_lane 1
      call $lookup_hashed local.tee $slot
      local.get $output local.get $index i32.const 1 i32.add i32.const 2 i32.shl i32.add
      local.get $slot i32.store
      local.get $found local.get $slot i32.const 0 i32.ge_s i32.add local.set $found

      local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
      local.get $keys i32x4.extract_lane 2 local.get $hashes i32x4.extract_lane 2
      call $lookup_hashed local.tee $slot
      local.get $output local.get $index i32.const 2 i32.add i32.const 2 i32.shl i32.add
      local.get $slot i32.store
      local.get $found local.get $slot i32.const 0 i32.ge_s i32.add local.set $found

      local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
      local.get $keys i32x4.extract_lane 3 local.get $hashes i32x4.extract_lane 3
      call $lookup_hashed local.tee $slot
      local.get $output local.get $index i32.const 3 i32.add i32.const 2 i32.shl i32.add
      local.get $slot i32.store
      local.get $found local.get $slot i32.const 0 i32.ge_s i32.add local.set $found

      local.get $index i32.const 4 i32.add local.set $index br $vectors
    end end
    block $done loop $tail
      local.get $index local.get $query_count i32.ge_u br_if $done
      local.get $displacements local.get $fingerprints local.get $bucket_count local.get $length
      local.get $queries local.get $index i32.const 2 i32.shl i32.add i32.load
      call $lookup local.tee $slot
      local.get $output local.get $index i32.const 2 i32.shl i32.add local.get $slot i32.store
      local.get $found local.get $slot i32.const 0 i32.ge_s i32.add local.set $found
      local.get $index i32.const 1 i32.add local.set $index br $tail
    end end
    local.get $found
  )
)
