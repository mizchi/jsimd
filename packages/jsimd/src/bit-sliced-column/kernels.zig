const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);

fn lessBlock(planes: [*]const U32x4, validity: [*]const U32x4, vector_index: usize, plane_vectors: usize, bit_width: u32, value: u32) U32x4 {
    if (value == 0) return @splat(0);
    if (bit_width < 32 and value >= (@as(u32, 1) << @intCast(bit_width))) return validity[vector_index];
    var equal = validity[vector_index];
    var less: U32x4 = @splat(0);
    var bit = bit_width;
    while (bit > 0) {
        bit -= 1;
        const plane = planes[@as(usize, bit) * plane_vectors + vector_index];
        if (((value >> @intCast(bit)) & 1) != 0) {
            less |= equal & ~plane;
            equal &= plane;
        } else equal &= ~plane;
    }
    return less;
}
export fn scan_eq(planes_ptr: u32, validity_ptr: u32, output_ptr: u32, word_count: u32, bit_width: u32, value: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(planes_ptr);
    const validity: [*]const U32x4 = @ptrFromInt(validity_ptr);
    const output: [*]U32x4 = @ptrFromInt(output_ptr);
    const vectors = word_count / 4;
    for (0..vectors) |v| {
        var result = validity[v];
        for (0..bit_width) |bit| {
            const plane = planes[bit * vectors + v];
            if (((value >> @intCast(bit)) & 1) != 0) result &= plane else result &= ~plane;
        }
        output[v] = result;
    }
}
export fn scan_lt(planes_ptr: u32, validity_ptr: u32, output_ptr: u32, word_count: u32, bit_width: u32, value: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(planes_ptr);
    const validity: [*]const U32x4 = @ptrFromInt(validity_ptr);
    const output: [*]U32x4 = @ptrFromInt(output_ptr);
    const vectors = word_count / 4;
    for (0..vectors) |v| output[v] = lessBlock(planes, validity, v, vectors, bit_width, value);
}
export fn scan_between(planes_ptr: u32, validity_ptr: u32, output_ptr: u32, word_count: u32, bit_width: u32, minimum: u32, maximum: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(planes_ptr);
    const validity: [*]const U32x4 = @ptrFromInt(validity_ptr);
    const output: [*]U32x4 = @ptrFromInt(output_ptr);
    const vectors = word_count / 4;
    for (0..vectors) |v| output[v] = lessBlock(planes, validity, v, vectors, bit_width, maximum) & ~lessBlock(planes, validity, v, vectors, bit_width, minimum);
}
const Op = enum { and_, or_, and_not };
fn maskOp(left: [*]U32x4, right: [*]const U32x4, words: usize, comptime op: Op) void {
    for (0..words / 4) |i| left[i] = switch (op) {
        .and_ => left[i] & right[i],
        .or_ => left[i] | right[i],
        .and_not => left[i] & ~right[i],
    };
}
export fn mask_and(l: u32, r: u32, n: u32) void {
    maskOp(@ptrFromInt(l), @ptrFromInt(r), n, .and_);
}
export fn mask_or(l: u32, r: u32, n: u32) void {
    maskOp(@ptrFromInt(l), @ptrFromInt(r), n, .or_);
}
export fn mask_andnot(l: u32, r: u32, n: u32) void {
    maskOp(@ptrFromInt(l), @ptrFromInt(r), n, .and_not);
}
export fn mask_count(ptr: u32, words: u32) u32 {
    const values: [*]const U32x4 = @ptrFromInt(ptr);
    var count: u32 = 0;
    for (0..words / 4) |i| {
        const bytes: U8x16 = @popCount(@as(U8x16, @bitCast(values[i])));
        count += @reduce(.Add, bytes);
    }
    return count;
}
test "less-than handles bounds" {
    const planes = [_]U32x4{@splat(0)};
    const valid = [_]U32x4{@splat(0xffff_ffff)};
    try std.testing.expectEqual(valid[0], lessBlock(&planes, &valid, 0, 1, 1, 2));
}
