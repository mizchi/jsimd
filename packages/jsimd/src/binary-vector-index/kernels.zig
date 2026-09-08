const std = @import("std");
const U8x16 = @Vector(16, u8);
const F32x4 = @Vector(4, f32);

noinline fn hamming(left: []const u8, right: []const u8) u32 {
    var count: u32 = 0;
    var offset: usize = 0;
    while (offset < left.len) : (offset += 16) {
        const a: U8x16 = @as(*align(1) const U8x16, @ptrCast(left.ptr + offset)).*;
        const b: U8x16 = @as(*align(1) const U8x16, @ptrCast(right.ptr + offset)).*;
        const bits: U8x16 = @popCount(a ^ b);
        count += @reduce(.Add, bits);
    }
    return count;
}

export fn distance_many(vectors_ptr: u32, query_ptr: u32, count: u32, stride: u32, output_ptr: u32) void {
    const vectors: [*]const u8 = @ptrFromInt(vectors_ptr);
    const query: [*]const u8 = @ptrFromInt(query_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    for (0..count) |i| output[i] = hamming(vectors[i * stride ..][0..stride], query[0..stride]);
}

export fn pdx_distance_many(vectors_ptr: u32, query_ptr: u32, count: u32, dimensions: u32, output_ptr: u32) void {
    const vectors: [*]const F32x4 = @ptrFromInt(vectors_ptr);
    const query: [*]const f32 = @ptrFromInt(query_ptr);
    const output: [*]F32x4 = @ptrFromInt(output_ptr);
    const blocks = (count + 3) / 4;
    for (0..blocks) |block| {
        var sum: F32x4 = @splat(0);
        for (0..dimensions) |dimension| {
            const delta = vectors[block * dimensions + dimension] - @as(F32x4, @splat(query[dimension]));
            sum += delta * delta;
        }
        output[block] = sum;
    }
}

inline fn pdxLane(vectors: [*]const F32x4, dimensions: usize, id: usize, dimension: usize) f32 {
    const lanes: [4]f32 = vectors[(id / 4) * dimensions + dimension];
    return lanes[id & 3];
}

export fn pdx_distance_selected(vectors_ptr: u32, query_ptr: u32, ids_ptr: u32, count: u32, dimensions: u32, output_ptr: u32) void {
    const vectors: [*]const F32x4 = @ptrFromInt(vectors_ptr);
    const query: [*]const f32 = @ptrFromInt(query_ptr);
    const ids: [*]const u32 = @ptrFromInt(ids_ptr);
    const output: [*]f32 = @ptrFromInt(output_ptr);
    var group: usize = 0;
    while (group < count) : (group += 4) {
        var sum: F32x4 = @splat(0);
        for (0..dimensions) |dimension| {
            var candidate_array = [_]f32{0} ** 4;
            for (0..4) |lane| if (group + lane < count) {
                candidate_array[lane] = pdxLane(vectors, dimensions, ids[group + lane], dimension);
            };
            const candidates: F32x4 = candidate_array;
            const delta = candidates - @as(F32x4, @splat(query[dimension]));
            sum += delta * delta;
        }
        const sum_array: [4]f32 = sum;
        for (0..4) |lane| {
            if (group + lane < count) output[group + lane] = sum_array[lane];
        }
    }
}

test "SIMD hamming reduction" {
    const a = [_]u8{0} ** 16;
    const b = [_]u8{0xff} ** 16;
    try std.testing.expectEqual(@as(u32, 128), hamming(&a, &b));
}
