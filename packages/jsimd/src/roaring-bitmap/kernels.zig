const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);
const bitmap_vectors = 8192 / 16;

fn popcount(value: U32x4) u32 {
    const counts: U8x16 = @popCount(@as(U8x16, @bitCast(value)));
    return @reduce(.Add, counts);
}

const BitmapOp = enum { and_, or_, xor_, and_not };
fn bitmapInto(left: [*]const U32x4, right: [*]const U32x4, output: [*]U32x4, comptime op: BitmapOp) u32 {
    var count: u32 = 0;
    for (0..bitmap_vectors) |i| {
        const value = switch (op) {
            .and_ => left[i] & right[i],
            .or_ => left[i] | right[i],
            .xor_ => left[i] ^ right[i],
            .and_not => left[i] & ~right[i],
        };
        output[i] = value;
        count += popcount(value);
    }
    return count;
}

export fn bitmap_and_count(left_ptr: u32, right_ptr: u32) u32 {
    const left: [*]const U32x4 = @ptrFromInt(left_ptr);
    const right: [*]const U32x4 = @ptrFromInt(right_ptr);
    var count: u32 = 0;
    for (0..bitmap_vectors) |i| count += popcount(left[i] & right[i]);
    return count;
}
export fn bitmap_intersects(left_ptr: u32, right_ptr: u32) u32 {
    const left: [*]const U32x4 = @ptrFromInt(left_ptr);
    const right: [*]const U32x4 = @ptrFromInt(right_ptr);
    for (0..bitmap_vectors) |i| if (@reduce(.Or, left[i] & right[i]) != 0) return 1;
    return 0;
}
export fn bitmap_and_into(a: u32, b: u32, out: u32) u32 {
    return bitmapInto(@ptrFromInt(a), @ptrFromInt(b), @ptrFromInt(out), .and_);
}
export fn bitmap_or_into(a: u32, b: u32, out: u32) u32 {
    return bitmapInto(@ptrFromInt(a), @ptrFromInt(b), @ptrFromInt(out), .or_);
}
export fn bitmap_xor_into(a: u32, b: u32, out: u32) u32 {
    return bitmapInto(@ptrFromInt(a), @ptrFromInt(b), @ptrFromInt(out), .xor_);
}
export fn bitmap_and_not_into(a: u32, b: u32, out: u32) u32 {
    return bitmapInto(@ptrFromInt(a), @ptrFromInt(b), @ptrFromInt(out), .and_not);
}

fn intersectArrays(left: []const u16, right: []const u16, output: ?[]u16, stop_early: bool) u32 {
    var i: usize = 0;
    var j: usize = 0;
    var count: usize = 0;
    while (i < left.len and j < right.len) {
        if (left[i] == right[j]) {
            if (stop_early) return 1;
            if (output) |out| out[count] = left[i];
            count += 1;
            i += 1;
            j += 1;
        } else if (left[i] < right[j]) i += 1 else j += 1;
    }
    return @intCast(count);
}
export fn array_array_count(a: u32, an: u32, b: u32, bn: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    const bp: [*]const u16 = @ptrFromInt(b);
    return intersectArrays(ap[0..an], bp[0..bn], null, false);
}
export fn array_array_intersects(a: u32, an: u32, b: u32, bn: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    const bp: [*]const u16 = @ptrFromInt(b);
    return intersectArrays(ap[0..an], bp[0..bn], null, true);
}
export fn array_array_and_into(a: u32, an: u32, b: u32, bn: u32, out: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    const bp: [*]const u16 = @ptrFromInt(b);
    const op: [*]u16 = @ptrFromInt(out);
    return intersectArrays(ap[0..an], bp[0..bn], op[0..@min(an, bn)], false);
}

inline fn bitmapHas(bitmap: [*]const u32, value: u16) bool {
    return (bitmap[value / 32] & (@as(u32, 1) << @intCast(value & 31))) != 0;
}
fn arrayBitmap(array: []const u16, bitmap: [*]const u32, output: ?[]u16, stop_early: bool) u32 {
    var count: usize = 0;
    for (array) |value| if (bitmapHas(bitmap, value)) {
        if (stop_early) return 1;
        if (output) |out| out[count] = value;
        count += 1;
    };
    return @intCast(count);
}
export fn array_bitmap_count(a: u32, n: u32, b: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    return arrayBitmap(ap[0..n], @ptrFromInt(b), null, false);
}
export fn array_bitmap_intersects(a: u32, n: u32, b: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    return arrayBitmap(ap[0..n], @ptrFromInt(b), null, true);
}
export fn array_bitmap_and_into(a: u32, n: u32, b: u32, out: u32) u32 {
    const ap: [*]const u16 = @ptrFromInt(a);
    const op: [*]u16 = @ptrFromInt(out);
    return arrayBitmap(ap[0..n], @ptrFromInt(b), op[0..n], false);
}

test "bitmap vectors count intersections" {
    try std.testing.expectEqual(@as(u32, 32), popcount(.{ 0xffff_ffff, 0, 0, 0 }));
}
