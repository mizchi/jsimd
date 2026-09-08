const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);
export fn fill_u32(pointer: u32, length: u32, value: u32) void {
    const out: [*]u32 = @ptrFromInt(pointer);
    const lanes: U32x4 = @splat(value);
    var i: usize = 0;
    while (i + 4 <= length) : (i += 4) @as(*align(4) U32x4, @ptrCast(out + i)).* = lanes;
    while (i < length) : (i += 1) out[i] = value;
}
export fn copy_bytes(destination: u32, source: u32, length: u32) void {
    const out: [*]u8 = @ptrFromInt(destination);
    const input: [*]const u8 = @ptrFromInt(source);
    var i: usize = 0;
    while (i + 16 <= length) : (i += 16) @as(*align(1) U8x16, @ptrCast(out + i)).* = @as(*align(1) const U8x16, @ptrCast(input + i)).*;
    while (i < length) : (i += 1) out[i] = input[i];
}
const Op = enum { or_, and_, sum };
fn reduce(destination: [*]U32x4, source: [*]const u8, shards: usize, stride: usize, words: usize, comptime op: Op) void {
    for (0..words / 4) |word| {
        var acc: U32x4 = switch (op) {
            .and_ => @splat(0xffff_ffff),
            else => @splat(0),
        };
        for (0..shards) |shard| {
            const values: U32x4 = @as(*align(1) const U32x4, @ptrCast(source + shard * stride + word * 16)).*;
            acc = switch (op) {
                .or_ => acc | values,
                .and_ => acc & values,
                .sum => acc +% values,
            };
        }
        destination[word] = acc;
    }
}
export fn reduce_shards_or(destination: u32, source: u32, shards: u32, stride: u32, words: u32) void {
    reduce(@ptrFromInt(destination), @ptrFromInt(source), shards, stride, words, .or_);
}
export fn reduce_shards_and(destination: u32, source: u32, shards: u32, stride: u32, words: u32) void {
    reduce(@ptrFromInt(destination), @ptrFromInt(source), shards, stride, words, .and_);
}
export fn reduce_shards_sum_u32(destination: u32, source: u32, shards: u32, stride: u32, words: u32) void {
    reduce(@ptrFromInt(destination), @ptrFromInt(source), shards, stride, words, .sum);
}
test "vector reduction operations" {
    var destination = [_]U32x4{@splat(0)};
    const source = [_]U32x4{ .{ 1, 2, 3, 4 }, .{ 4, 3, 2, 1 } };
    reduce(&destination, @ptrCast(&source), 2, 16, 4, .sum);
    try std.testing.expectEqual(U32x4{ 5, 5, 5, 5 }, destination[0]);
}
