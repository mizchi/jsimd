const std = @import("std");
const F32x4 = @Vector(4, f32);
const Metric = enum { squared_l2, l1, inner_product };

fn distances(vectors: [*]const F32x4, query: []const f32, count: usize, output: [*]F32x4, comptime metric: Metric) void {
    const blocks = (count + 63) / 64;
    for (0..blocks) |block| {
        for (0..16) |group| output[block * 16 + group] = @splat(0);
        for (query, 0..) |q, dimension| {
            const query_lanes: F32x4 = @splat(q);
            const base = (block * query.len + dimension) * 16;
            for (0..16) |group| {
                const values = vectors[base + group];
                output[block * 16 + group] += switch (metric) {
                    .squared_l2 => blk: {
                        const delta = values - query_lanes;
                        break :blk delta * delta;
                    },
                    .l1 => @abs(values - query_lanes),
                    .inner_product => values * query_lanes,
                };
            }
        }
    }
}

export fn squared_distance_many(vectors_ptr: u32, query_ptr: u32, count: u32, dimensions: u32, output_ptr: u32) void {
    const q: [*]const f32 = @ptrFromInt(query_ptr);
    distances(@ptrFromInt(vectors_ptr), q[0..dimensions], count, @ptrFromInt(output_ptr), .squared_l2);
}
export fn l1_distance_many(vectors_ptr: u32, query_ptr: u32, count: u32, dimensions: u32, output_ptr: u32) void {
    const q: [*]const f32 = @ptrFromInt(query_ptr);
    distances(@ptrFromInt(vectors_ptr), q[0..dimensions], count, @ptrFromInt(output_ptr), .l1);
}
export fn inner_product_many(vectors_ptr: u32, query_ptr: u32, count: u32, dimensions: u32, output_ptr: u32) void {
    const q: [*]const f32 = @ptrFromInt(query_ptr);
    distances(@ptrFromInt(vectors_ptr), q[0..dimensions], count, @ptrFromInt(output_ptr), .inner_product);
}

inline fn greater(distance_a: f32, id_a: u32, distance_b: f32, id_b: u32) bool {
    return distance_a > distance_b or (distance_a == distance_b and id_a > id_b);
}
fn swap(ids: [*]u32, scores: [*]f32, a: usize, b: usize) void {
    const id = ids[a];
    ids[a] = ids[b];
    ids[b] = id;
    const score = scores[a];
    scores[a] = scores[b];
    scores[b] = score;
}
fn siftUp(ids: [*]u32, scores: [*]f32, start: usize) void {
    var child = start;
    while (child != 0) {
        const parent = (child - 1) / 2;
        if (greater(scores[parent], ids[parent], scores[child], ids[child])) break;
        swap(ids, scores, parent, child);
        child = parent;
    }
}
fn siftDown(ids: [*]u32, scores: [*]f32, start: usize, size: usize) void {
    var parent = start;
    while (true) {
        const left = parent * 2 + 1;
        if (left >= size) return;
        const right = left + 1;
        var child = left;
        if (right < size and greater(scores[right], ids[right], scores[left], ids[left])) child = right;
        if (!greater(scores[child], ids[child], scores[parent], ids[parent])) return;
        swap(ids, scores, parent, child);
        parent = child;
    }
}
fn selectTopK(scratch: [*]const f32, count: usize, ids: [*]u32, scores: [*]f32, k: usize) void {
    var filled: usize = 0;
    for (0..count) |candidate| {
        const score = scratch[candidate];
        if (filled < k) {
            ids[filled] = @intCast(candidate);
            scores[filled] = score;
            siftUp(ids, scores, filled);
            filled += 1;
        } else if (greater(scores[0], ids[0], score, @intCast(candidate))) {
            ids[0] = @intCast(candidate);
            scores[0] = score;
            siftDown(ids, scores, 0, k);
        }
    }
    var size = k;
    while (size > 1) {
        size -= 1;
        swap(ids, scores, 0, size);
        siftDown(ids, scores, 0, size);
    }
}

export fn top_k(vectors: u32, query: u32, count: u32, dimensions: u32, scratch_ptr: u32, ids_ptr: u32, scores_ptr: u32, k: u32) void {
    squared_distance_many(vectors, query, count, dimensions, scratch_ptr);
    selectTopK(@ptrFromInt(scratch_ptr), count, @ptrFromInt(ids_ptr), @ptrFromInt(scores_ptr), k);
}
export fn top_k_inner_product(vectors: u32, query: u32, count: u32, dimensions: u32, scratch_ptr: u32, ids_ptr: u32, scores_ptr: u32, k: u32) void {
    inner_product_many(vectors, query, count, dimensions, scratch_ptr);
    const scratch: [*]f32 = @ptrFromInt(scratch_ptr);
    for (0..count) |i| scratch[i] = -scratch[i];
    selectTopK(scratch, count, @ptrFromInt(ids_ptr), @ptrFromInt(scores_ptr), k);
    const scores: [*]f32 = @ptrFromInt(scores_ptr);
    for (0..k) |i| scores[i] = -scores[i];
}

test "heap ordering breaks ties by row id" {
    try std.testing.expect(greater(2, 0, 1, 9));
    try std.testing.expect(greater(1, 9, 1, 2));
}
