(module
  (import "jsimd" "memory" (memory 1))

  (func (export "table_checksum")
    (param $cells i32)
    (param $count i32)
    (param $table i32)
    (result i32)
    (local $index i32)
    (local $material i32)
    (local $checksum i32)

    block $done
      loop $cells_loop
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done
        local.get $cells
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        i32.load
        i32.const 255
        i32.and
        local.set $material
        local.get $checksum
        local.get $table
        local.get $material
        i32.add
        i32.load8_u
        i32.add
        local.set $checksum
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $cells_loop
      end
    end
    local.get $checksum)

  ;; Models a fused specialized kernel that compares four cells against every known material.
  (func (export "specialized_simd_checksum")
    (param $cells i32)
    (param $count i32)
    (param $material_count i32)
    (result i32)
    (local $index i32)
    (local $rule i32)
    (local $checksum i32)
    (local $material v128)
    (local $classified v128)
    (local $mask v128)

    block $done
      loop $groups
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done
        local.get $cells
        local.get $index
        i32.const 2
        i32.shl
        i32.add
        v128.load
        i32.const 255
        i32x4.splat
        v128.and
        local.set $material
        v128.const i32x4 0 0 0 0
        local.set $classified
        i32.const 0
        local.set $rule
        block $rules_done
          loop $rules
            local.get $rule
            local.get $material_count
            i32.ge_u
            br_if $rules_done
            local.get $material
            local.get $rule
            i32x4.splat
            i32x4.eq
            local.set $mask
            local.get $rule
            i32x4.splat
            local.get $classified
            local.get $mask
            v128.bitselect
            local.set $classified
            local.get $rule
            i32.const 1
            i32.add
            local.set $rule
            br $rules
          end
        end
        local.get $checksum
        local.get $classified
        i32x4.extract_lane 0
        i32.add
        local.get $classified
        i32x4.extract_lane 1
        i32.add
        local.get $classified
        i32x4.extract_lane 2
        i32.add
        local.get $classified
        i32x4.extract_lane 3
        i32.add
        local.set $checksum
        local.get $index
        i32.const 4
        i32.add
        local.set $index
        br $groups
      end
    end
    local.get $checksum))
