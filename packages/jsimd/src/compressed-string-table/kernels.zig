const std = @import("std");
const U8x16 = @Vector(16, u8);

fn copyBytes(source: []const u8, output: []u8) void {
    var i: usize = 0;
    while (i + 16 <= source.len) : (i += 16) {
        const lanes: U8x16 = @as(*align(1) const U8x16, @ptrCast(source.ptr + i)).*;
        @as(*align(1) U8x16, @ptrCast(output.ptr + i)).* = lanes;
    }
    while (i < source.len) : (i += 1) output[i] = source[i];
}

fn equalBytes(left: []const u8, right: []const u8) bool {
    var i: usize = 0;
    while (i + 16 <= left.len) : (i += 16) {
        const a: U8x16 = @as(*align(1) const U8x16, @ptrCast(left.ptr + i)).*;
        const b: U8x16 = @as(*align(1) const U8x16, @ptrCast(right.ptr + i)).*;
        if (!@reduce(.And, a == b)) return false;
    }
    return std.mem.eql(u8, left[i..], right[i..]);
}

fn lengths(prefix_lengths: [*]const u32, suffix_offsets: [*]const u32, suffix_lengths: [*]const u32, id: usize) struct { prefix: usize, suffix_offset: usize, suffix: usize } {
    return .{ .prefix = prefix_lengths[id], .suffix_offset = suffix_offsets[id], .suffix = suffix_lengths[id] };
}

export fn decode(anchor_offsets_ptr: u32, prefix_lengths_ptr: u32, suffix_offsets_ptr: u32, suffix_lengths_ptr: u32, arena_ptr: u32, id_value: u32, output_ptr: u32) u32 {
    const anchors: [*]const u32 = @ptrFromInt(anchor_offsets_ptr);
    const prefixes: [*]const u32 = @ptrFromInt(prefix_lengths_ptr);
    const suffix_offsets: [*]const u32 = @ptrFromInt(suffix_offsets_ptr);
    const suffixes: [*]const u32 = @ptrFromInt(suffix_lengths_ptr);
    const arena: [*]const u8 = @ptrFromInt(arena_ptr);
    const output: [*]u8 = @ptrFromInt(output_ptr);
    const id: usize = id_value;
    const info = lengths(prefixes, suffix_offsets, suffixes, id);
    copyBytes(arena[anchors[id / 16]..][0..info.prefix], output[0..info.prefix]);
    copyBytes(arena[info.suffix_offset..][0..info.suffix], output[info.prefix..][0..info.suffix]);
    return @intCast(info.prefix + info.suffix);
}

fn equalsImpl(anchors: [*]const u32, prefixes: [*]const u32, suffix_offsets: [*]const u32, suffixes: [*]const u32, arena: [*]const u8, id: usize, query: []const u8) bool {
    const info = lengths(prefixes, suffix_offsets, suffixes, id);
    if (info.prefix + info.suffix != query.len) return false;
    return equalBytes(arena[anchors[id / 16]..][0..info.prefix], query[0..info.prefix]) and
        equalBytes(arena[info.suffix_offset..][0..info.suffix], query[info.prefix..]);
}

export fn equals(anchor_offsets_ptr: u32, prefix_lengths_ptr: u32, suffix_offsets_ptr: u32, suffix_lengths_ptr: u32, arena_ptr: u32, id: u32, query_ptr: u32, query_length: u32) u32 {
    const anchors: [*]const u32 = @ptrFromInt(anchor_offsets_ptr);
    const prefixes: [*]const u32 = @ptrFromInt(prefix_lengths_ptr);
    const suffix_offsets: [*]const u32 = @ptrFromInt(suffix_offsets_ptr);
    const suffixes: [*]const u32 = @ptrFromInt(suffix_lengths_ptr);
    const arena: [*]const u8 = @ptrFromInt(arena_ptr);
    const query: [*]const u8 = @ptrFromInt(query_ptr);
    return @intFromBool(equalsImpl(anchors, prefixes, suffix_offsets, suffixes, arena, id, query[0..query_length]));
}

export fn equals_many(anchor_offsets_ptr: u32, prefix_lengths_ptr: u32, suffix_offsets_ptr: u32, suffix_lengths_ptr: u32, arena_ptr: u32, ids_ptr: u32, queries_ptr: u32, offsets_ptr: u32, count: u32, output_ptr: u32) void {
    const anchors: [*]const u32 = @ptrFromInt(anchor_offsets_ptr);
    const prefixes: [*]const u32 = @ptrFromInt(prefix_lengths_ptr);
    const suffix_offsets: [*]const u32 = @ptrFromInt(suffix_offsets_ptr);
    const suffixes: [*]const u32 = @ptrFromInt(suffix_lengths_ptr);
    const arena: [*]const u8 = @ptrFromInt(arena_ptr);
    const ids: [*]const u32 = @ptrFromInt(ids_ptr);
    const queries: [*]const u8 = @ptrFromInt(queries_ptr);
    const offsets: [*]const u32 = @ptrFromInt(offsets_ptr);
    const output: [*]u8 = @ptrFromInt(output_ptr);
    for (0..count) |i| output[i] = @intFromBool(equalsImpl(anchors, prefixes, suffix_offsets, suffixes, arena, ids[i], queries[offsets[i]..offsets[i + 1]]));
}

test "SIMD byte equality supports tails" {
    const a = "abcdefghijklmnop-tail";
    try std.testing.expect(equalBytes(a, a));
    try std.testing.expect(!equalBytes(a, "abcdefghijklmnop-fail"));
}
