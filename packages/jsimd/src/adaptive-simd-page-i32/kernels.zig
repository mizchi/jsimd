const std = @import("std");
const I32x4 = @Vector(4, i32);
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);
fn packedAt(p: [*]const u32, width: u32, index: usize) u32 {
    const bit = index * width;
    const word = bit / 32;
    const shift: u5 = @intCast(bit & 31);
    var value = p[word] >> shift;
    if (@as(u32, shift) + width > 32) value |= p[word + 1] << @intCast(32 - @as(u32, shift));
    return value & ((@as(u32, 1) << @intCast(width)) - 1);
}
fn for4(p: [*]const u32, width: u32, base: i32, index: usize, n: usize) I32x4 {
    var a = [_]i32{base} ** 4;
    for (0..4) |lane| {
        if (index + lane < n) a[lane] = base +% @as(i32, @bitCast(packedAt(p, width, index + lane)));
    }
    return a;
}
fn store4(out: [*]u32, index: usize, n: usize, matches: @Vector(4, bool)) void {
    var bits: u32 = @as(u4, @bitCast(matches));
    const remaining = n - index;
    if (remaining < 4) bits &= (@as(u32, 1) << @intCast(remaining)) - 1;
    out[index / 32] |= bits << @intCast(index & 31);
}
export fn decode_raw(input_ptr: u32, output_ptr: u32, n: u32) void {
    const input: [*]const U32x4 = @ptrFromInt(input_ptr);
    const output: [*]U32x4 = @ptrFromInt(output_ptr);
    for (0..(n + 3) / 4) |i| output[i] = input[i];
}
export fn decode_for(p: u32, o: u32, n: u32, w: u32, base: i32) void {
    const packed_values: [*]const u32 = @ptrFromInt(p);
    const out: [*]i32 = @ptrFromInt(o);
    for (0..n) |i| out[i] = base +% @as(i32, @bitCast(packedAt(packed_values, w, i)));
}
export fn sum_raw(input_ptr: u32, n: u32) i64 {
    const input: [*]const i32 = @ptrFromInt(input_ptr);
    var total: i64 = 0;
    var i: usize = 0;
    while (i + 4 <= n) : (i += 4) {
        const v: I32x4 = @as(*align(1) const I32x4, @ptrCast(input + i)).*;
        total += v[0];
        total += v[1];
        total += v[2];
        total += v[3];
    }
    while (i < n) : (i += 1) total += input[i];
    return total;
}
export fn sum_for(p: u32, n: u32, w: u32, base: i32) i64 {
    const packed_values: [*]const u32 = @ptrFromInt(p);
    var total: i64 = 0;
    for (0..n) |i| total += base +% @as(i32, @bitCast(packedAt(packed_values, w, i)));
    return total;
}
const Cmp = enum { eq, lt, between };
fn scanRaw(input: [*]const i32, out: [*]u32, n: usize, a: i32, b: i32, comptime cmp: Cmp) void {
    var i: usize = 0;
    while (i < n) : (i += 4) {
        const v: I32x4 = @as(*align(1) const I32x4, @ptrCast(input + i)).*;
        store4(out, i, n, switch (cmp) {
            .eq => v == @as(I32x4, @splat(a)),
            .lt => v < @as(I32x4, @splat(a)),
            .between => (v >= @as(I32x4, @splat(a))) & (v < @as(I32x4, @splat(b))),
        });
    }
}
fn scanFor(p: [*]const u32, out: [*]u32, n: usize, w: u32, base: i32, a: i32, b: i32, comptime cmp: Cmp) void {
    var i: usize = 0;
    while (i < n) : (i += 4) {
        const v = for4(p, w, base, i, n);
        store4(out, i, n, switch (cmp) {
            .eq => v == @as(I32x4, @splat(a)),
            .lt => v < @as(I32x4, @splat(a)),
            .between => (v >= @as(I32x4, @splat(a))) & (v < @as(I32x4, @splat(b))),
        });
    }
}
export fn scan_eq_raw(i: u32, o: u32, n: u32, v: i32) void {
    scanRaw(@ptrFromInt(i), @ptrFromInt(o), n, v, 0, .eq);
}
export fn scan_lt_raw(i: u32, o: u32, n: u32, v: i32) void {
    scanRaw(@ptrFromInt(i), @ptrFromInt(o), n, v, 0, .lt);
}
export fn scan_between_raw(i: u32, o: u32, n: u32, a: i32, b: i32) void {
    scanRaw(@ptrFromInt(i), @ptrFromInt(o), n, a, b, .between);
}
export fn scan_eq_for(p: u32, o: u32, n: u32, w: u32, base: i32, v: i32) void {
    scanFor(@ptrFromInt(p), @ptrFromInt(o), n, w, base, v, 0, .eq);
}
export fn scan_lt_for(p: u32, o: u32, n: u32, w: u32, base: i32, v: i32) void {
    scanFor(@ptrFromInt(p), @ptrFromInt(o), n, w, base, v, 0, .lt);
}
export fn scan_between_for(p: u32, o: u32, n: u32, w: u32, base: i32, a: i32, b: i32) void {
    scanFor(@ptrFromInt(p), @ptrFromInt(o), n, w, base, a, b, .between);
}
fn selected(mask: [*]const u32, i: usize) bool {
    return ((mask[i / 32] >> @intCast(i & 31)) & 1) != 0;
}
export fn gather_raw(input_ptr: u32, mask_ptr: u32, output_ptr: u32, n: u32) u32 {
    const input: [*]const u32 = @ptrFromInt(input_ptr);
    const mask: [*]const u32 = @ptrFromInt(mask_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    var written: usize = 0;
    for (0..n) |i| if (selected(mask, i)) {
        out[written] = input[i];
        written += 1;
    };
    return @intCast(written);
}
export fn gather_for(p: u32, m: u32, o: u32, n: u32, w: u32, base: i32) u32 {
    const packed_values: [*]const u32 = @ptrFromInt(p);
    const mask: [*]const u32 = @ptrFromInt(m);
    const out: [*]i32 = @ptrFromInt(o);
    var written: usize = 0;
    for (0..n) |i| if (selected(mask, i)) {
        out[written] = base +% @as(i32, @bitCast(packedAt(packed_values, w, i)));
        written += 1;
    };
    return @intCast(written);
}
fn dictionaryLower(d: [*]const i32, n: usize, target: i32) usize {
    var low: usize = 0;
    while (low < n and d[low] < target) low += 1;
    return low;
}
export fn decode_dictionary(d: u32, c: u32, o: u32, n: u32) void {
    const dict: [*]const i32 = @ptrFromInt(d);
    const codes: [*]const u8 = @ptrFromInt(c);
    const out: [*]i32 = @ptrFromInt(o);
    for (0..n) |i| out[i] = dict[codes[i]];
}
export fn sum_dictionary(d: u32, card: u32) i64 {
    const dict: [*]const i32 = @ptrFromInt(d);
    const counts: [*]const u32 = @ptrFromInt(d + card * 4);
    var total: i64 = 0;
    for (0..card) |i| total += @as(i64, dict[i]) * counts[i];
    return total;
}
fn store16(out: [*]u16, index: usize, n: usize, matches: @Vector(16, bool)) void {
    var bits: u16 = @bitCast(matches);
    const rem = n - index;
    if (rem < 16) bits &= (@as(u16, 1) << @intCast(rem)) - 1;
    out[index / 16] = bits;
}
export fn scan_eq_dictionary(d: u32, c: u32, o: u32, n: u32, card: u32, target: i32) void {
    const dict: [*]const i32 = @ptrFromInt(d);
    const code = dictionaryLower(dict, card, target);
    if (code >= card or dict[code] != target) return;
    const codes: [*]const u8 = @ptrFromInt(c);
    const out: [*]u16 = @ptrFromInt(o);
    var i: usize = 0;
    while (i < n) : (i += 16) {
        const v: U8x16 = @as(*align(1) const U8x16, @ptrCast(codes + i)).*;
        store16(out, i, n, v == @as(U8x16, @splat(@intCast(code))));
    }
}
export fn scan_lt_dictionary(d: u32, c: u32, o: u32, n: u32, card: u32, target: i32) void {
    const upper: u8 = @intCast(dictionaryLower(@ptrFromInt(d), card, target));
    const codes: [*]const u8 = @ptrFromInt(c);
    const out: [*]u16 = @ptrFromInt(o);
    var i: usize = 0;
    while (i < n) : (i += 16) {
        const v: U8x16 = @as(*align(1) const U8x16, @ptrCast(codes + i)).*;
        store16(out, i, n, v < @as(U8x16, @splat(upper)));
    }
}
export fn scan_between_dictionary(d: u32, c: u32, o: u32, n: u32, card: u32, min: i32, max: i32) void {
    const dict: [*]const i32 = @ptrFromInt(d);
    const lower: u8 = @intCast(dictionaryLower(dict, card, min));
    const upper: u8 = @intCast(dictionaryLower(dict, card, max));
    const codes: [*]const u8 = @ptrFromInt(c);
    const out: [*]u16 = @ptrFromInt(o);
    var i: usize = 0;
    while (i < n) : (i += 16) {
        const v: U8x16 = @as(*align(1) const U8x16, @ptrCast(codes + i)).*;
        store16(out, i, n, (v >= @as(U8x16, @splat(lower))) & (v < @as(U8x16, @splat(upper))));
    }
}
export fn gather_dictionary(d: u32, c: u32, m: u32, o: u32, n: u32) u32 {
    const dict: [*]const i32 = @ptrFromInt(d);
    const codes: [*]const u8 = @ptrFromInt(c);
    const mask: [*]const u32 = @ptrFromInt(m);
    const out: [*]i32 = @ptrFromInt(o);
    var written: usize = 0;
    for (0..n) |i| if (selected(mask, i)) {
        out[written] = dict[codes[i]];
        written += 1;
    };
    return @intCast(written);
}
fn fillMask(out: [*]u32, n: usize) void {
    const words = (n + 31) / 32;
    for (0..words) |i| out[i] = 0xffff_ffff;
    if (n & 31 != 0) out[words - 1] = (@as(u32, 1) << @intCast(n & 31)) - 1;
}
fn assign(out: [*]u32, pos: usize, on: bool) void {
    const bit = @as(u32, 1) << @intCast(pos & 31);
    if (on) out[pos / 32] |= bit else out[pos / 32] &= ~bit;
}
export fn decode_sparse(pos: u32, val: u32, o: u32, n: u32, count: u32, default: i32) void {
    const positions: [*]const u8 = @ptrFromInt(pos);
    const values: [*]const i32 = @ptrFromInt(val);
    const out: [*]i32 = @ptrFromInt(o);
    var i: usize = 0;
    const lanes: I32x4 = @splat(default);
    while (i + 4 <= n) : (i += 4) @as(*align(1) I32x4, @ptrCast(out + i)).* = lanes;
    while (i < n) : (i += 1) out[i] = default;
    for (0..count) |e| out[positions[e]] = values[e];
}
export fn sum_sparse(val: u32, n: u32, count: u32, default: i32) i64 {
    const values: [*]const i32 = @ptrFromInt(val);
    var total: @TypeOf(@as(i64, 0)) = @as(i64, default) * (n - count);
    for (0..count) |i| total += values[i];
    return total;
}
const SparseCmp = enum { eq, lt, between };
fn scanSparse(pos: [*]const u8, val: [*]const i32, out: [*]u32, n: usize, count: usize, default: i32, a: i32, b: i32, comptime cmp: SparseCmp) void {
    const base = switch (cmp) {
        .eq => default == a,
        .lt => default < a,
        .between => default >= a and default < b,
    };
    if (base) fillMask(out, n);
    for (0..count) |i| assign(out, pos[i], switch (cmp) {
        .eq => val[i] == a,
        .lt => val[i] < a,
        .between => val[i] >= a and val[i] < b,
    });
}
export fn scan_eq_sparse(p: u32, v: u32, o: u32, n: u32, c: u32, d: i32, t: i32) void {
    scanSparse(@ptrFromInt(p), @ptrFromInt(v), @ptrFromInt(o), n, c, d, t, 0, .eq);
}
export fn scan_lt_sparse(p: u32, v: u32, o: u32, n: u32, c: u32, d: i32, t: i32) void {
    scanSparse(@ptrFromInt(p), @ptrFromInt(v), @ptrFromInt(o), n, c, d, t, 0, .lt);
}
export fn scan_between_sparse(p: u32, v: u32, o: u32, n: u32, c: u32, d: i32, a: i32, b: i32) void {
    scanSparse(@ptrFromInt(p), @ptrFromInt(v), @ptrFromInt(o), n, c, d, a, b, .between);
}
export fn gather_sparse(p: u32, v: u32, m: u32, o: u32, n: u32, c: u32, d: i32) u32 {
    const pos: [*]const u8 = @ptrFromInt(p);
    const val: [*]const i32 = @ptrFromInt(v);
    const mask: [*]const u32 = @ptrFromInt(m);
    const out: [*]i32 = @ptrFromInt(o);
    var e: usize = 0;
    var written: usize = 0;
    for (0..n) |i| {
        var value = d;
        if (e < c and pos[e] == i) {
            value = val[e];
            e += 1;
        }
        if (selected(mask, i)) {
            out[written] = value;
            written += 1;
        }
    }
    return @intCast(written);
}
const Run = extern struct { value: i32, end: u32 };
export fn decode_rle(r: u32, o: u32, count: u32) void {
    const runs: [*]const Run = @ptrFromInt(r);
    const out: [*]i32 = @ptrFromInt(o);
    var start: usize = 0;
    for (0..count) |i| {
        const lanes: I32x4 = @splat(runs[i].value);
        while (start + 4 <= runs[i].end) : (start += 4) @as(*align(1) I32x4, @ptrCast(out + start)).* = lanes;
        while (start < runs[i].end) : (start += 1) out[start] = runs[i].value;
    }
}
export fn sum_rle(r: u32, count: u32) i64 {
    const runs: [*]const Run = @ptrFromInt(r);
    var start: u32 = 0;
    var total: i64 = 0;
    for (0..count) |i| {
        total += @as(i64, runs[i].value) * (runs[i].end - start);
        start = runs[i].end;
    }
    return total;
}
fn setRange(out: [*]u32, start: usize, end: usize) void {
    for (start..end) |i| out[i / 32] |= @as(u32, 1) << @intCast(i & 31);
}
const RunCmp = enum { eq, lt, between };
fn scanRuns(r: [*]const Run, out: [*]u32, count: usize, a: i32, b: i32, comptime cmp: RunCmp) void {
    var start: usize = 0;
    for (0..count) |i| {
        const yes = switch (cmp) {
            .eq => r[i].value == a,
            .lt => r[i].value < a,
            .between => r[i].value >= a and r[i].value < b,
        };
        if (yes) setRange(out, start, r[i].end);
        start = r[i].end;
    }
}
export fn scan_eq_rle(r: u32, o: u32, c: u32, t: i32) void {
    scanRuns(@ptrFromInt(r), @ptrFromInt(o), c, t, 0, .eq);
}
export fn scan_lt_rle(r: u32, o: u32, c: u32, t: i32) void {
    scanRuns(@ptrFromInt(r), @ptrFromInt(o), c, t, 0, .lt);
}
export fn scan_between_rle(r: u32, o: u32, c: u32, a: i32, b: i32) void {
    scanRuns(@ptrFromInt(r), @ptrFromInt(o), c, a, b, .between);
}
export fn gather_rle(r: u32, m: u32, o: u32, c: u32) u32 {
    const runs: [*]const Run = @ptrFromInt(r);
    const mask: [*]const u32 = @ptrFromInt(m);
    const out: [*]i32 = @ptrFromInt(o);
    var start: usize = 0;
    var written: usize = 0;
    for (0..c) |run| {
        while (start < runs[run].end) : (start += 1) if (selected(mask, start)) {
            out[written] = runs[run].value;
            written += 1;
        };
    }
    return @intCast(written);
}
const Op = enum { and_, or_, and_not };
fn maskOp(l: [*]U32x4, r: [*]const U32x4, n: usize, comptime op: Op) void {
    for (0..n / 4) |i| l[i] = switch (op) {
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
test "raw SIMD scan" {
    const input = [_]i32{ -1, 0, 2, 3 };
    var out = [_]u32{0};
    scanRaw(&input, &out, 4, 2, 0, .lt);
    try std.testing.expectEqual(@as(u32, 3), out[0]);
}
