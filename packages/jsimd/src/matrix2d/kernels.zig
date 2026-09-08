const std = @import("std");

const F32x4 = @Vector(4, f32);

fn addVectors(target: []f32, source: []const f32) void {
    var index: usize = 0;
    while (index < target.len) : (index += 4) {
        const target_lanes: *align(1) F32x4 = @ptrCast(target.ptr + index);
        const source_lanes: *align(1) const F32x4 = @ptrCast(source.ptr + index);
        target_lanes.* += source_lanes.*;
    }
}

export fn add(target_ptr: u32, source_ptr: u32, length: u32) void {
    const target: [*]f32 = @ptrFromInt(target_ptr);
    const source: [*]const f32 = @ptrFromInt(source_ptr);
    addVectors(target[0..length], source[0..length]);
}

fn scaleVector(target: []f32, factor: f32) void {
    const factor_lanes: F32x4 = @splat(factor);
    var index: usize = 0;
    while (index < target.len) : (index += 4) {
        const target_lanes: *align(1) F32x4 = @ptrCast(target.ptr + index);
        target_lanes.* *= factor_lanes;
    }
}

export fn scale(target_ptr: u32, length: u32, factor: f32) void {
    const target: [*]f32 = @ptrFromInt(target_ptr);
    scaleVector(target[0..length], factor);
}

fn multiply(
    left: []const f32,
    right: []const f32,
    output: []f32,
    rows: usize,
    inner: usize,
    output_stride: usize,
    left_stride: usize,
) void {
    for (0..rows) |row| {
        const output_row = row * output_stride;
        for (0..inner) |index| {
            const value: F32x4 = @splat(left[row * left_stride + index]);
            var column: usize = 0;
            while (column < output_stride) : (column += 4) {
                const output_lanes: *align(1) F32x4 = @ptrCast(output.ptr + output_row + column);
                const right_lanes: *align(1) const F32x4 = @ptrCast(right.ptr + index * output_stride + column);
                output_lanes.* += value * right_lanes.*;
            }
        }
    }
}

export fn matmul(
    left_ptr: u32,
    right_ptr: u32,
    output_ptr: u32,
    rows: u32,
    inner: u32,
    output_stride: u32,
    left_stride: u32,
) void {
    const left: [*]const f32 = @ptrFromInt(left_ptr);
    const right: [*]const f32 = @ptrFromInt(right_ptr);
    const output: [*]f32 = @ptrFromInt(output_ptr);
    multiply(
        left[0 .. @as(usize, rows) * left_stride],
        right[0 .. @as(usize, inner) * output_stride],
        output[0 .. @as(usize, rows) * output_stride],
        rows,
        inner,
        output_stride,
        left_stride,
    );
}

test "padded matrix multiplication and vector operations agree" {
    var left = [_]f32{ 1, 2, 3, 0, 4, 5, 6, 0 };
    const right = [_]f32{ 7, 8, 0, 0, 9, 10, 0, 0, 11, 12, 0, 0 };
    var output = [_]f32{0} ** 8;
    multiply(&left, &right, &output, 2, 3, 4, 4);
    try std.testing.expectEqualSlices(f32, &[_]f32{ 58, 64, 0, 0, 139, 154, 0, 0 }, &output);
    addVectors(&left, &[_]f32{ 1, 1, 1, 0, 1, 1, 1, 0 });
    scaleVector(&left, 0.5);
    try std.testing.expectEqualSlices(f32, &[_]f32{ 1, 1.5, 2, 0, 2.5, 3, 3.5, 0 }, &left);
}
