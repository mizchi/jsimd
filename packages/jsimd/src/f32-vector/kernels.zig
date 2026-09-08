const std = @import("std");

const F32x4 = @Vector(4, f32);

fn horizontalSum(value: F32x4) f32 {
    return value[0] + value[1] + value[2] + value[3];
}

fn dotProduct(left: []const f32, right: []const f32) f32 {
    var sum: F32x4 = @splat(0);
    var index: usize = 0;
    while (index < left.len) : (index += 4) {
        const left_lanes: *align(1) const F32x4 = @ptrCast(left.ptr + index);
        const right_lanes: *align(1) const F32x4 = @ptrCast(right.ptr + index);
        sum += left_lanes.* * right_lanes.*;
    }
    return horizontalSum(sum);
}

export fn dot(left_ptr: u32, right_ptr: u32, length: u32) f32 {
    const left: [*]const f32 = @ptrFromInt(left_ptr);
    const right: [*]const f32 = @ptrFromInt(right_ptr);
    return dotProduct(left[0..length], right[0..length]);
}

fn squaredDistance(left: []const f32, right: []const f32) f32 {
    var sum: F32x4 = @splat(0);
    var index: usize = 0;
    while (index < left.len) : (index += 4) {
        const left_lanes: *align(1) const F32x4 = @ptrCast(left.ptr + index);
        const right_lanes: *align(1) const F32x4 = @ptrCast(right.ptr + index);
        const delta = left_lanes.* - right_lanes.*;
        sum += delta * delta;
    }
    return horizontalSum(sum);
}

export fn squared_distance(left_ptr: u32, right_ptr: u32, length: u32) f32 {
    const left: [*]const f32 = @ptrFromInt(left_ptr);
    const right: [*]const f32 = @ptrFromInt(right_ptr);
    return squaredDistance(left[0..length], right[0..length]);
}

export fn norm(value_ptr: u32, length: u32) f32 {
    const values: [*]const f32 = @ptrFromInt(value_ptr);
    return @sqrt(dotProduct(values[0..length], values[0..length]));
}

fn cosineSimilarity(left: []const f32, right: []const f32) f32 {
    var dot_sum: F32x4 = @splat(0);
    var left_sum: F32x4 = @splat(0);
    var right_sum: F32x4 = @splat(0);
    var index: usize = 0;
    while (index < left.len) : (index += 4) {
        const left_lanes: *align(1) const F32x4 = @ptrCast(left.ptr + index);
        const right_lanes: *align(1) const F32x4 = @ptrCast(right.ptr + index);
        dot_sum += left_lanes.* * right_lanes.*;
        left_sum += left_lanes.* * left_lanes.*;
        right_sum += right_lanes.* * right_lanes.*;
    }
    return horizontalSum(dot_sum) / @sqrt(horizontalSum(left_sum) * horizontalSum(right_sum));
}

export fn cosine_similarity(left_ptr: u32, right_ptr: u32, length: u32) f32 {
    const left: [*]const f32 = @ptrFromInt(left_ptr);
    const right: [*]const f32 = @ptrFromInt(right_ptr);
    return cosineSimilarity(left[0..length], right[0..length]);
}

fn addScaled(target: []f32, source: []const f32, scale: f32) void {
    const scale_lanes: F32x4 = @splat(scale);
    var index: usize = 0;
    while (index < target.len) : (index += 4) {
        const target_lanes: *align(1) F32x4 = @ptrCast(target.ptr + index);
        const source_lanes: *align(1) const F32x4 = @ptrCast(source.ptr + index);
        target_lanes.* += source_lanes.* * scale_lanes;
    }
}

export fn axpy(target_ptr: u32, source_ptr: u32, length: u32, scale: f32) void {
    const target: [*]f32 = @ptrFromInt(target_ptr);
    const source: [*]const f32 = @ptrFromInt(source_ptr);
    addScaled(target[0..length], source[0..length], scale);
}

test "vector reductions and AXPY preserve padded-lane semantics" {
    var left = [_]f32{ 1, 2, 3, 4, 0, 0, 0, 0 };
    const right = [_]f32{ 4, 3, 2, 1, 0, 0, 0, 0 };
    try std.testing.expectApproxEqAbs(@as(f32, 20), dotProduct(&left, &right), 0.0001);
    try std.testing.expectApproxEqAbs(@as(f32, 20), squaredDistance(&left, &right), 0.0001);
    addScaled(&left, &right, 0.5);
    try std.testing.expectEqualSlices(f32, &[_]f32{ 3, 3.5, 4, 4.5, 0, 0, 0, 0 }, &left);
}
