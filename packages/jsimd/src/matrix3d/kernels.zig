const std = @import("std");
const F32x4 = @Vector(4, f32);

fn addSlices(target: []f32, source: []const f32) void {
    var i: usize = 0;
    while (i < target.len) : (i += 4) {
        const a: *align(1) F32x4 = @ptrCast(target.ptr + i);
        const b: F32x4 = @as(*align(1) const F32x4, @ptrCast(source.ptr + i)).*;
        a.* += b;
    }
}

export fn add(target_ptr: u32, source_ptr: u32, n: u32) void {
    const target: [*]f32 = @ptrFromInt(target_ptr);
    const source: [*]const f32 = @ptrFromInt(source_ptr);
    addSlices(target[0..n], source[0..n]);
}

fn scaleSlice(target: []f32, factor: f32) void {
    const factors: F32x4 = @splat(factor);
    var i: usize = 0;
    while (i < target.len) : (i += 4) {
        const lanes: *align(1) F32x4 = @ptrCast(target.ptr + i);
        lanes.* *= factors;
    }
}

export fn scale(target_ptr: u32, n: u32, factor: f32) void {
    const target: [*]f32 = @ptrFromInt(target_ptr);
    scaleSlice(target[0..n], factor);
}

export fn batched_matmul(left_ptr: u32, right_ptr: u32, output_ptr: u32, batches: u32, rows: u32, inner: u32, output_stride: u32, left_stride: u32) void {
    const left: [*]const f32 = @ptrFromInt(left_ptr);
    const right: [*]const f32 = @ptrFromInt(right_ptr);
    const output: [*]f32 = @ptrFromInt(output_ptr);
    var batch: usize = 0;
    while (batch < batches) : (batch += 1) {
        const left_base = batch * rows * left_stride;
        const right_base = batch * inner * output_stride;
        const output_base = batch * rows * output_stride;
        var row: usize = 0;
        while (row < rows) : (row += 1) {
            var k: usize = 0;
            while (k < inner) : (k += 1) {
                const value: F32x4 = @splat(left[left_base + row * left_stride + k]);
                var column: usize = 0;
                while (column < output_stride) : (column += 4) {
                    const out: *align(1) F32x4 = @ptrCast(output + output_base + row * output_stride + column);
                    const rhs: F32x4 = @as(*align(1) const F32x4, @ptrCast(right + right_base + k * output_stride + column)).*;
                    out.* += value * rhs;
                }
            }
        }
    }
}

test "matrix element operations use four SIMD lanes" {
    var target = [_]f32{ 1, 2, 3, 4 };
    const source = [_]f32{ 4, 3, 2, 1 };
    addSlices(&target, &source);
    scaleSlice(&target, 2);
    try std.testing.expectEqualSlices(f32, &[_]f32{ 10, 10, 10, 10 }, &target);
}
