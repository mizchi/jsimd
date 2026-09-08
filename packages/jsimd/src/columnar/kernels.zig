const std = @import("std");
const U32x4 = @Vector(4, u32);
const I32x4 = @Vector(4, i32);
const U8x16 = @Vector(16, u8);
fn packedAt(p: [*]const u32, width: u32, index: usize) u32 {
    const bit = index * width;
    const word = bit / 32;
    const shift: u5 = @intCast(bit & 31);
    var value = p[word] >> shift;
    if (@as(u32, shift) + width > 32) value |= p[word + 1] << @intCast(32 - @as(u32, shift));
    return value & ((@as(u32, 1) << @intCast(width)) - 1);
}
fn for4(p: [*]const u32, width: u32, base: u32, index: usize, n: usize) U32x4 {
    var a = [_]u32{base} ** 4;
    for (0..4) |lane| if (index + lane < n) {
        a[lane] = base +% packedAt(p, width, index + lane);
    };
    return a;
}
fn storeMask(output: [*]u32, index: usize, n: usize, bits_: u4) void {
    var bits: u32 = bits_;
    const remaining = n - index;
    if (remaining < 4) bits &= (@as(u32, 1) << @intCast(remaining)) - 1;
    output[index / 32] |= bits << @intCast(index & 31);
}
const Cmp = enum { eq, lt, between };
fn scanRaw(comptime T: type, input: [*]const T, output: [*]u32, n: usize, a: T, b: T, comptime cmp: Cmp) void {
    var i: usize = 0;
    while (i < n) : (i += 4) {
        const values: @Vector(4, T) = @as(*align(1) const @Vector(4, T), @ptrCast(input + i)).*;
        const matches = switch (cmp) {
            .eq => values == @as(@Vector(4, T), @splat(a)),
            .lt => values < @as(@Vector(4, T), @splat(a)),
            .between => (values >= @as(@Vector(4, T), @splat(a))) & (values < @as(@Vector(4, T), @splat(b))),
        };
        storeMask(output, i, n, @bitCast(matches));
    }
}
fn scanFor(comptime T: type, p: [*]const u32, output: [*]u32, n: usize, width: u32, base: u32, a: T, b: T, comptime cmp: Cmp) void {
    var i: usize = 0;
    while (i < n) : (i += 4) {
        const unsigned = for4(p, width, base, i, n);
        const values: @Vector(4, T) = @bitCast(unsigned);
        const matches = switch (cmp) {
            .eq => values == @as(@Vector(4, T), @splat(a)),
            .lt => values < @as(@Vector(4, T), @splat(a)),
            .between => (values >= @as(@Vector(4, T), @splat(a))) & (values < @as(@Vector(4, T), @splat(b))),
        };
        storeMask(output, i, n, @bitCast(matches));
    }
}
export fn scan_i32_eq_raw(i: u32, o: u32, n: u32, v: i32) void {
    scanRaw(i32, @ptrFromInt(i), @ptrFromInt(o), n, v, 0, .eq);
}
export fn scan_i32_lt_raw(i: u32, o: u32, n: u32, v: i32) void {
    scanRaw(i32, @ptrFromInt(i), @ptrFromInt(o), n, v, 0, .lt);
}
export fn scan_i32_between_raw(i: u32, o: u32, n: u32, a: i32, b: i32) void {
    scanRaw(i32, @ptrFromInt(i), @ptrFromInt(o), n, a, b, .between);
}
export fn scan_u32_eq_raw(i: u32, o: u32, n: u32, v: u32) void {
    scanRaw(u32, @ptrFromInt(i), @ptrFromInt(o), n, v, 0, .eq);
}
export fn scan_u32_lt_raw(i: u32, o: u32, n: u32, v: u32) void {
    scanRaw(u32, @ptrFromInt(i), @ptrFromInt(o), n, v, 0, .lt);
}
export fn scan_u32_between_raw(i: u32, o: u32, n: u32, a: u32, b: u32) void {
    scanRaw(u32, @ptrFromInt(i), @ptrFromInt(o), n, a, b, .between);
}
export fn scan_i32_eq_for(p: u32, o: u32, n: u32, w: u32, base: i32, v: i32) void {
    scanFor(i32, @ptrFromInt(p), @ptrFromInt(o), n, w, @bitCast(base), v, 0, .eq);
}
export fn scan_i32_lt_for(p: u32, o: u32, n: u32, w: u32, base: i32, v: i32) void {
    scanFor(i32, @ptrFromInt(p), @ptrFromInt(o), n, w, @bitCast(base), v, 0, .lt);
}
export fn scan_i32_between_for(p: u32, o: u32, n: u32, w: u32, base: i32, a: i32, b: i32) void {
    scanFor(i32, @ptrFromInt(p), @ptrFromInt(o), n, w, @bitCast(base), a, b, .between);
}
export fn scan_u32_eq_for(p: u32, o: u32, n: u32, w: u32, base: u32, v: u32) void {
    scanFor(u32, @ptrFromInt(p), @ptrFromInt(o), n, w, base, v, 0, .eq);
}
export fn scan_u32_lt_for(p: u32, o: u32, n: u32, w: u32, base: u32, v: u32) void {
    scanFor(u32, @ptrFromInt(p), @ptrFromInt(o), n, w, base, v, 0, .lt);
}
export fn scan_u32_between_for(p: u32, o: u32, n: u32, w: u32, base: u32, a: u32, b: u32) void {
    scanFor(u32, @ptrFromInt(p), @ptrFromInt(o), n, w, base, a, b, .between);
}
fn lessBlock(planes: [*]const U32x4, valid: [*]const U32x4, v: usize, stride: usize, width: u32, value: u32) U32x4 {
    if (value == 0) return @splat(0);
    if (width < 32 and value >= (@as(u32, 1) << @intCast(width))) return valid[v];
    var equal = valid[v];
    var less: U32x4 = @splat(0);
    var bit = width;
    while (bit > 0) {
        bit -= 1;
        const plane = planes[@as(usize, bit) * stride + v];
        if (((value >> @intCast(bit)) & 1) != 0) {
            less |= equal & ~plane;
            equal &= plane;
        } else equal &= ~plane;
    }
    return less;
}
export fn scan_u8_eq(p: u32, v: u32, o: u32, words: u32, width: u32, value: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(p);
    const valid: [*]const U32x4 = @ptrFromInt(v);
    const out: [*]U32x4 = @ptrFromInt(o);
    const stride = words / 4;
    for (0..stride) |i| {
        var result = valid[i];
        for (0..width) |bit| {
            if (((value >> @intCast(bit)) & 1) != 0) result &= planes[bit * stride + i] else result &= ~planes[bit * stride + i];
        }
        out[i] = result;
    }
}
export fn scan_u8_lt(p: u32, v: u32, o: u32, words: u32, width: u32, value: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(p);
    const valid: [*]const U32x4 = @ptrFromInt(v);
    const out: [*]U32x4 = @ptrFromInt(o);
    const stride = words / 4;
    for (0..stride) |i| out[i] = lessBlock(planes, valid, i, stride, width, value);
}
export fn scan_u8_between(p: u32, v: u32, o: u32, words: u32, width: u32, a: u32, b: u32) void {
    const planes: [*]const U32x4 = @ptrFromInt(p);
    const valid: [*]const U32x4 = @ptrFromInt(v);
    const out: [*]U32x4 = @ptrFromInt(o);
    const stride = words / 4;
    for (0..stride) |i| out[i] = lessBlock(planes, valid, i, stride, width, b) & ~lessBlock(planes, valid, i, stride, width, a);
}
fn gatherMask(mask: [*]const u32, n: usize, ctx: anytype, comptime get: fn (@TypeOf(ctx), usize) u32, output: [*]u32) u32 {
    var written: usize = 0;
    for (0..(n + 31) / 32) |word| {
        var bits = mask[word];
        while (bits != 0) {
            const index = word * 32 + @ctz(bits);
            output[written] = get(ctx, index);
            written += 1;
            bits &= bits - 1;
        }
    }
    return @intCast(written);
}
fn constant(v: u32, index: usize) u32 {
    _ = index;
    return v;
}
fn rawGet(p: [*]const u32, index: usize) u32 {
    return p[index];
}
const ForCtx = struct { p: [*]const u32, w: u32, b: u32 };
fn forGet(c: ForCtx, index: usize) u32 {
    return c.b +% packedAt(c.p, c.w, index);
}
export fn gather_i32_constant(m: u32, n: u32, value: u32, o: u32) u32 {
    return gatherMask(@ptrFromInt(m), n, value, constant, @ptrFromInt(o));
}
export fn gather_i32_raw(i: u32, m: u32, n: u32, o: u32) u32 {
    return gatherMask(@ptrFromInt(m), n, @as([*]const u32, @ptrFromInt(i)), rawGet, @ptrFromInt(o));
}
export fn gather_i32_for(p: u32, m: u32, n: u32, w: u32, b: u32, o: u32) u32 {
    return gatherMask(@ptrFromInt(m), n, ForCtx{ .p = @ptrFromInt(p), .w = w, .b = b }, forGet, @ptrFromInt(o));
}
export fn gather_u8(p: u32, v: u32, m: u32, words: u32, width: u32, o: u32, ov: u32) u32 {
    const planes: [*]const u32 = @ptrFromInt(p);
    const valid: [*]const u32 = @ptrFromInt(v);
    const mask: [*]const u32 = @ptrFromInt(m);
    const output: [*]u8 = @ptrFromInt(o);
    const output_valid: [*]u8 = @ptrFromInt(ov);
    var written: usize = 0;
    for (0..words) |word| {
        var bits = mask[word];
        while (bits != 0) {
            const index = word * 32 + @ctz(bits);
            const is_valid: u8 = @intCast((valid[word] >> @intCast(index & 31)) & 1);
            var value: u8 = 0;
            for (0..width) |bit| value |= @as(u8, @intCast((planes[bit * words + index / 32] >> @intCast(index & 31)) & 1)) << @intCast(bit);
            output[written] = value * is_valid;
            output_valid[written] = is_valid;
            written += 1;
            bits &= bits - 1;
        }
    }
    return @intCast(written);
}
const Op = enum { and_, or_, and_not };
fn maskOp(l: [*]U32x4, r: [*]const U32x4, words: usize, comptime op: Op) void {
    for (0..words / 4) |i| l[i] = switch (op) {
        .and_ => l[i] & r[i],
        .or_ => l[i] | r[i],
        .and_not => l[i] & ~r[i],
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
export fn mask_not(p: u32, n: u32) void {
    const x: [*]U32x4 = @ptrFromInt(p);
    for (0..n / 4) |i| x[i] = ~x[i];
}
export fn mask_count(p: u32, n: u32) u32 {
    const x: [*]const U32x4 = @ptrFromInt(p);
    var count: u32 = 0;
    for (0..n / 4) |i| {
        const c: U8x16 = @popCount(@as(U8x16, @bitCast(x[i])));
        count += @reduce(.Add, c);
    }
    return count;
}
export fn mask_positions_into(p: u32, n: u32, o: u32) u32 {
    const x: [*]const u32 = @ptrFromInt(p);
    const out: [*]u32 = @ptrFromInt(o);
    var written: usize = 0;
    for (0..n) |word| {
        var bits = x[word];
        while (bits != 0) {
            out[written] = @intCast(word * 32 + @ctz(bits));
            written += 1;
            bits &= bits - 1;
        }
    }
    return @intCast(written);
}
test "four-lane comparisons produce bit masks" {
    var out = [_]u32{0};
    const input = [_]i32{ -1, 0, 2, 3 };
    scanRaw(i32, &input, &out, 4, 2, 0, .lt);
    try std.testing.expectEqual(@as(u32, 3), out[0]);
}
