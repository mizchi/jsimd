const std = @import("std");
const U8x16 = @Vector(16, u8);

inline fn mix32(value_: u32) u32 {
    var value = value_;
    value ^= value >> 16;
    value *%= 0x7feb352d;
    value ^= value >> 15;
    value *%= 0x846ca68b;
    value ^= value >> 16;
    return value;
}

fn mergeRegister(left: u8, right: u8) u8 {
    if (left == 0) return right;
    if (right == 0) return left;
    const left_rank = left >> 2;
    const right_rank = right >> 2;
    if (left_rank == right_rank) return (left & 0xfc) | ((left | right) & 3);
    const larger = if (left_rank > right_rank) left else right;
    const smaller = if (left_rank > right_rank) right else left;
    const difference = if (left_rank > right_rank) left_rank - right_rank else right_rank - left_rank;
    var history = larger & 3;
    if (difference == 1) history |= 2 | ((smaller >> 1) & 1) else if (difference == 2) history |= 1;
    return (larger & 0xfc) | history;
}

fn mergeVector(left: U8x16, right: U8x16) U8x16 {
    const rank_mask: U8x16 = @splat(0xfc);
    const history_mask: U8x16 = @splat(3);
    const left_rank = left & rank_mask;
    const right_rank = right & rank_mask;
    const high = @max(left_rank, right_rank);
    const low = @min(left_rank, right_rank);
    const difference = high - low;
    const left_larger = left_rank == high;
    const same = left_rank == right_rank;
    const larger = @select(u8, left_larger, left, right);
    const smaller = @select(u8, left_larger, right, left);
    var history = larger & history_mask;
    const adjacent = (history | @as(U8x16, @splat(2))) | ((smaller >> @as(U8x16, @splat(1))) & @as(U8x16, @splat(1)));
    history = @select(u8, difference == @as(U8x16, @splat(4)), adjacent, history);
    history = @select(u8, difference == @as(U8x16, @splat(8)), history | @as(U8x16, @splat(1)), history);
    var result = high | history;
    result = @select(u8, same, high | ((left | right) & history_mask), result);
    result = @select(u8, left == @as(U8x16, @splat(0)), right, result);
    return @select(u8, right == @as(U8x16, @splat(0)), left, result);
}

export fn add_u32_many(state_ptr: u32, precision: u32, values_ptr: u32, length: u32) void {
    const state: [*]u8 = @ptrFromInt(state_ptr);
    const values: [*]const u32 = @ptrFromInt(values_ptr);
    for (0..length) |i| {
        const high = mix32(values[i] ^ 0x9e3779b9);
        const low = mix32(values[i] ^ 0x85ebca6b);
        const register_index = high >> (@as(u5, @intCast(32 - precision)));
        const shifted_high = (high << @as(u5, @intCast(precision))) | (low >> @as(u5, @intCast(32 - precision)));
        const shifted_low = low << @as(u5, @intCast(precision));
        var leading: u32 = if (shifted_high == 0) @clz(shifted_low) + 32 else @clz(shifted_high);
        leading = @min(leading, 64 - precision);
        const event: u8 = @truncate((precision - 1 + leading) << 2);
        state[register_index] = mergeRegister(state[register_index], event);
    }
}

export fn merge_state(output_ptr: u32, other_ptr: u32, register_count: u32) void {
    const output: [*]u8 = @ptrFromInt(output_ptr);
    const other: [*]const u8 = @ptrFromInt(other_ptr);
    var i: usize = 0;
    while (i + 16 <= register_count) : (i += 16) {
        const left: *align(1) U8x16 = @ptrCast(output + i);
        const right: U8x16 = @as(*align(1) const U8x16, @ptrCast(other + i)).*;
        left.* = mergeVector(left.*, right);
    }
    while (i < register_count) : (i += 1) output[i] = mergeRegister(output[i], other[i]);
}

test "vector register merge matches scalar lanes" {
    const a: U8x16 = .{ 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60 };
    const b: U8x16 = .{ 4, 0, 12, 8, 20, 16, 28, 24, 36, 32, 44, 40, 52, 48, 60, 56 };
    const merged: [16]u8 = mergeVector(a, b);
    const aa: [16]u8 = a;
    const bb: [16]u8 = b;
    for (0..16) |i| try std.testing.expectEqual(mergeRegister(aa[i], bb[i]), merged[i]);
}
