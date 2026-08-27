(module
  (memory (export "memory") 1)

  (func (export "add") (param $target i32) (param $source i32) (param $n i32)
    (local $i i32)
    block $done
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $target local.get $i i32.const 2 i32.shl i32.add
        local.get $target local.get $i i32.const 2 i32.shl i32.add v128.load
        local.get $source local.get $i i32.const 2 i32.shl i32.add v128.load
        f32x4.add v128.store
        local.get $i i32.const 4 i32.add local.set $i br $loop
      end
    end
  )

  (func (export "scale") (param $target i32) (param $n i32) (param $factor f32)
    (local $i i32)
    block $done
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $done
        local.get $target local.get $i i32.const 2 i32.shl i32.add
        local.get $target local.get $i i32.const 2 i32.shl i32.add v128.load
        local.get $factor f32x4.splat f32x4.mul v128.store
        local.get $i i32.const 4 i32.add local.set $i br $loop
      end
    end
  )

  ;; Batch-major Float32 matmul. Every matrix row is padded to four lanes.
  ;; output[b,i,j:j+4] += splat(left[b,i,k]) * right[b,k,j:j+4]
  (func (export "batched_matmul")
    (param $left i32) (param $right i32) (param $output i32)
    (param $batches i32) (param $rows i32) (param $inner i32)
    (param $output_stride i32) (param $left_stride i32)
    (local $batch i32) (local $row i32) (local $index i32) (local $column i32)
    (local $left_batch i32) (local $right_batch i32) (local $output_batch i32)
    (local $value f32)
    block $batches_done
      loop $batches_loop
        local.get $batch local.get $batches i32.ge_u br_if $batches_done

        local.get $left
        local.get $batch local.get $rows i32.mul local.get $left_stride i32.mul
        i32.const 2 i32.shl i32.add local.set $left_batch
        local.get $right
        local.get $batch local.get $inner i32.mul local.get $output_stride i32.mul
        i32.const 2 i32.shl i32.add local.set $right_batch
        local.get $output
        local.get $batch local.get $rows i32.mul local.get $output_stride i32.mul
        i32.const 2 i32.shl i32.add local.set $output_batch

        i32.const 0 local.set $row
        block $rows_done
          loop $rows_loop
            local.get $row local.get $rows i32.ge_u br_if $rows_done
            i32.const 0 local.set $index
            block $inner_done
              loop $inner_loop
                local.get $index local.get $inner i32.ge_u br_if $inner_done
                local.get $left_batch
                local.get $row local.get $left_stride i32.mul local.get $index i32.add
                i32.const 2 i32.shl i32.add f32.load local.set $value
                i32.const 0 local.set $column
                block $columns_done
                  loop $columns_loop
                    local.get $column local.get $output_stride i32.ge_u br_if $columns_done
                    local.get $output_batch
                    local.get $row local.get $output_stride i32.mul local.get $column i32.add
                    i32.const 2 i32.shl i32.add
                    local.get $output_batch
                    local.get $row local.get $output_stride i32.mul local.get $column i32.add
                    i32.const 2 i32.shl i32.add v128.load
                    local.get $right_batch
                    local.get $index local.get $output_stride i32.mul local.get $column i32.add
                    i32.const 2 i32.shl i32.add v128.load
                    local.get $value f32x4.splat f32x4.mul f32x4.add v128.store
                    local.get $column i32.const 4 i32.add local.set $column br $columns_loop
                  end
                end
                local.get $index i32.const 1 i32.add local.set $index br $inner_loop
              end
            end
            local.get $row i32.const 1 i32.add local.set $row br $rows_loop
          end
        end
        local.get $batch i32.const 1 i32.add local.set $batch br $batches_loop
      end
    end
  )
)
