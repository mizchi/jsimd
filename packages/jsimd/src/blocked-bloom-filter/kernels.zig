const std = @import("std");
const U32x4 = @Vector(4, u32);

inline fn mix(input: u32) u32 {
    var value = input;
    value ^= value >> 16;
    value *%= 0x7feb352d;
    value ^= value >> 15;
    value *%= 0x846ca68b;
    value ^= value >> 16;
    return value;
}

inline fn bitMask(hash: u32) U32x4 {
    return .{
        @as(u32, 1) << @intCast(hash & 31),
        @as(u32, 1) << @intCast((hash >> 8) & 31),
        @as(u32, 1) << @intCast((hash >> 16) & 31),
        @as(u32, 1) << @intCast((hash >> 24) & 31),
    };
}

export fn add_many(blocks_ptr: u32, block_count: u32, keys_ptr: u32, length: u32) void {
    const blocks: [*]U32x4 = @ptrFromInt(blocks_ptr);
    const keys: [*]const u32 = @ptrFromInt(keys_ptr);
    var i: usize = 0;
    while (i < length) : (i += 1) {
        const hash = mix(keys[i]);
        blocks[hash % block_count] |= bitMask(mix(hash ^ 0x9e3779b9));
    }
}

export fn may_contain_many(blocks_ptr: u32, block_count: u32, keys_ptr: u32, output_ptr: u32, length: u32) u32 {
    const blocks: [*]const U32x4 = @ptrFromInt(blocks_ptr);
    const keys: [*]const u32 = @ptrFromInt(keys_ptr);
    const output: [*]u8 = @ptrFromInt(output_ptr);
    var count: u32 = 0;
    var i: usize = 0;
    while (i < length) : (i += 1) {
        const hash = mix(keys[i]);
        const mask = bitMask(mix(hash ^ 0x9e3779b9));
        const present = @reduce(.And, (blocks[hash % block_count] & mask) == mask);
        output[i] = @intFromBool(present);
        count += @intFromBool(present);
    }
    return count;
}

export fn merge(blocks_ptr: u32, other_ptr: u32, block_count: u32) void {
    const blocks: [*]U32x4 = @ptrFromInt(blocks_ptr);
    const other: [*]const U32x4 = @ptrFromInt(other_ptr);
    for (0..block_count) |i| blocks[i] |= other[i];
}

test "hash mask assigns one bit per lane" {
    const mask = bitMask(0x1f100800);
    try std.testing.expectEqual(@as(u32, 1), @popCount(mask[0]));
    try std.testing.expectEqual(@as(u32, 1), @popCount(mask[3]));
}
