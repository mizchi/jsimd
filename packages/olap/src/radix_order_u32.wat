(module
  (import "jsimd" "memory" (memory 1 65536))

  (func $clear_histogram (param $histogram i32)
    (local $offset i32)
    block $done loop $loop
      local.get $offset i32.const 1024 i32.ge_u br_if $done
      local.get $histogram local.get $offset i32.add
      v128.const i32x4 0 0 0 0 v128.store
      local.get $offset i32.const 16 i32.add local.set $offset
      br $loop
    end end)

  (func $prefix (param $histogram i32)
    (local $index i32) (local $count i32) (local $sum i32) (local $address i32)
    block $done loop $loop
      local.get $index i32.const 256 i32.ge_u br_if $done
      local.get $histogram local.get $index i32.const 2 i32.shl i32.add local.tee $address
      i32.load local.set $count
      local.get $address local.get $sum i32.store
      local.get $sum local.get $count i32.add local.set $sum
      local.get $index i32.const 1 i32.add local.set $index
      br $loop
    end end)

  (func $pass
    (param $source_keys i32) (param $source_payloads i32)
    (param $destination_keys i32) (param $destination_payloads i32)
    (param $length i32) (param $shift i32) (param $histogram i32)
    (local $index i32) (local $key i32) (local $payload i32) (local $bucket i32)
    (local $address i32) (local $position i32)
    local.get $histogram call $clear_histogram
    block $count_done loop $count
      local.get $index local.get $length i32.ge_u br_if $count_done
      local.get $source_keys local.get $index i32.const 2 i32.shl i32.add i32.load local.set $key
      local.get $key local.get $shift i32.shr_u i32.const 255 i32.and local.set $bucket
      local.get $histogram local.get $bucket i32.const 2 i32.shl i32.add local.set $address
      local.get $address local.get $address i32.load i32.const 1 i32.add i32.store
      local.get $index i32.const 1 i32.add local.set $index
      br $count
    end end
    local.get $histogram call $prefix
    i32.const 0 local.set $index
    block $scatter_done loop $scatter
      local.get $index local.get $length i32.ge_u br_if $scatter_done
      local.get $source_keys local.get $index i32.const 2 i32.shl i32.add i32.load local.set $key
      local.get $source_payloads local.get $index i32.const 2 i32.shl i32.add i32.load local.set $payload
      local.get $key local.get $shift i32.shr_u i32.const 255 i32.and local.set $bucket
      local.get $histogram local.get $bucket i32.const 2 i32.shl i32.add local.set $address
      local.get $address i32.load local.set $position
      local.get $address local.get $position i32.const 1 i32.add i32.store
      local.get $destination_keys local.get $position i32.const 2 i32.shl i32.add
      local.get $key i32.store
      local.get $destination_payloads local.get $position i32.const 2 i32.shl i32.add
      local.get $payload i32.store
      local.get $index i32.const 1 i32.add local.set $index
      br $scatter
    end end)

  (func (export "sort_u32_pairs")
    (param $keys i32) (param $payloads i32)
    (param $scratch_keys i32) (param $scratch_payloads i32)
    (param $length i32) (param $histogram i32)
    local.get $keys local.get $payloads local.get $scratch_keys local.get $scratch_payloads
    local.get $length i32.const 0 local.get $histogram call $pass
    local.get $scratch_keys local.get $scratch_payloads local.get $keys local.get $payloads
    local.get $length i32.const 8 local.get $histogram call $pass
    local.get $keys local.get $payloads local.get $scratch_keys local.get $scratch_payloads
    local.get $length i32.const 16 local.get $histogram call $pass
    local.get $scratch_keys local.get $scratch_payloads local.get $keys local.get $payloads
    local.get $length i32.const 24 local.get $histogram call $pass))
