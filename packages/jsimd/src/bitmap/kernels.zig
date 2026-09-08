const std = @import("std");

const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);
const BinaryOperation = enum { and_, or_, xor_, and_not };

inline fn applyBinary(comptime operation: BinaryOperation, left: []const u32, right: []const u32, output: []u32) void {
    var index: usize = 0;
    while (index < output.len) : (index += 4) {
        const left_chunk: *align(1) const U32x4 = @ptrCast(left.ptr + index);
        const right_chunk: *align(1) const U32x4 = @ptrCast(right.ptr + index);
        const output_chunk: *align(1) U32x4 = @ptrCast(output.ptr + index);
        output_chunk.* = switch (operation) {
            .and_ => left_chunk.* & right_chunk.*,
            .or_ => left_chunk.* | right_chunk.*,
            .xor_ => left_chunk.* ^ right_chunk.*,
            .and_not => left_chunk.* & ~right_chunk.*,
        };
    }
}

inline fn binaryFromPointers(comptime operation: BinaryOperation, left_ptr: u32, right_ptr: u32, output_ptr: u32, words: u32) void {
    const left: [*]const u32 = @ptrFromInt(left_ptr);
    const right: [*]const u32 = @ptrFromInt(right_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    applyBinary(operation, left[0..words], right[0..words], output[0..words]);
}

export fn @"and"(left_ptr: u32, right_ptr: u32, output_ptr: u32, words: u32) void {
    binaryFromPointers(.and_, left_ptr, right_ptr, output_ptr, words);
}

export fn @"or"(left_ptr: u32, right_ptr: u32, output_ptr: u32, words: u32) void {
    binaryFromPointers(.or_, left_ptr, right_ptr, output_ptr, words);
}

export fn xor(left_ptr: u32, right_ptr: u32, output_ptr: u32, words: u32) void {
    binaryFromPointers(.xor_, left_ptr, right_ptr, output_ptr, words);
}

export fn and_not(left_ptr: u32, right_ptr: u32, output_ptr: u32, words: u32) void {
    binaryFromPointers(.and_not, left_ptr, right_ptr, output_ptr, words);
}

noinline fn horizontalPopcount(value: U32x4) u32 {
    const bytes: U8x16 = @bitCast(value);
    const lane_counts: U8x16 = @popCount(bytes);
    return @reduce(.Add, lane_counts);
}

fn countWords(words: []const u32) u32 {
    var result: u32 = 0;
    var index: usize = 0;
    while (index < words.len) : (index += 4) {
        const chunk: *align(1) const U32x4 = @ptrCast(words.ptr + index);
        result += horizontalPopcount(chunk.*);
    }
    return result;
}

export fn count(pointer: u32, words: u32) u32 {
    const values: [*]const u32 = @ptrFromInt(pointer);
    return countWords(values[0..words]);
}

fn intersectionCount(left: []const u32, right: []const u32) u32 {
    var result: u32 = 0;
    var index: usize = 0;
    while (index < left.len) : (index += 4) {
        const left_chunk: *align(1) const U32x4 = @ptrCast(left.ptr + index);
        const right_chunk: *align(1) const U32x4 = @ptrCast(right.ptr + index);
        result += horizontalPopcount(left_chunk.* & right_chunk.*);
    }
    return result;
}

export fn intersection_count(left_ptr: u32, right_ptr: u32, words: u32) u32 {
    const left: [*]const u32 = @ptrFromInt(left_ptr);
    const right: [*]const u32 = @ptrFromInt(right_ptr);
    return intersectionCount(left[0..words], right[0..words]);
}

test "bitmap vector operations and population counts agree" {
    const left = [_]u32{ 0xffff_0000, 0xaaaa_aaaa, 0x0000_0001, 0xffff_ffff };
    const right = [_]u32{ 0x0f0f_0f0f, 0x5555_5555, 0x0000_0003, 0x0000_0000 };
    var output: [4]u32 = undefined;

    applyBinary(.and_, &left, &right, &output);
    try std.testing.expectEqualSlices(u32, &[_]u32{ 0x0f0f_0000, 0, 1, 0 }, &output);
    try std.testing.expectEqual(@as(u32, 65), countWords(&left));
    try std.testing.expectEqual(@as(u32, 9), intersectionCount(&left, &right));
}
