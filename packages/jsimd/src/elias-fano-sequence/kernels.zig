const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);
fn pop4(v: U32x4) u32 {
    const c: U8x16 = @popCount(@as(U8x16, @bitCast(v)));
    return @reduce(.Add, c);
}
export fn build_rank_index(bits_ptr: u32, index_ptr: u32, padded_words: u32, superblocks: u32) u32 {
    const bits: [*]const u32 = @ptrFromInt(bits_ptr);
    const index: [*]u32 = @ptrFromInt(index_ptr);
    var count: u32 = 0;
    for (0..superblocks) |super| {
        index[super] = count;
        var word = super * 16;
        const end = @min(word + 16, padded_words);
        while (word + 4 <= end) : (word += 4) count += pop4(@as(*align(1) const U32x4, @ptrCast(bits + word)).*);
        while (word < end) : (word += 1) count += @popCount(bits[word]);
    }
    index[superblocks] = count;
    return count;
}
fn select1(bits: [*]const u32, padded_words: usize, target: usize) i32 {
    var remaining = target;
    for (0..padded_words) |word_index| {
        var word = bits[word_index];
        const count = @popCount(word);
        if (remaining < count) {
            while (remaining > 0) : (remaining -= 1) word &= word - 1;
            return @intCast(word_index * 32 + @ctz(word));
        }
        remaining -= count;
    }
    return -1;
}
fn lowAt(low: [*]const u32, width: u32, index: usize) u32 {
    if (width == 0) return 0;
    if (width == 32) return low[index];
    const offset = index * width;
    const word = offset / 32;
    const shift: u5 = @intCast(offset & 31);
    var value = low[word] >> shift;
    if (@as(u32, shift) + width > 32) value |= low[word + 1] << @intCast(32 - @as(u32, shift));
    return value & ((@as(u32, 1) << @intCast(width)) - 1);
}
fn atImpl(high: [*]const u32, low: [*]const u32, padded: usize, width: u32, index: usize) u32 {
    if (width == 32) return lowAt(low, width, index);
    return (@as(u32, @intCast(select1(high, padded, index))) - @as(u32, @intCast(index))) << @intCast(width) | lowAt(low, width, index);
}
export fn at(high: u32, index_ptr: u32, low: u32, padded: u32, superblocks: u32, width: u32, i: u32) u32 {
    _ = index_ptr;
    _ = superblocks;
    return atImpl(@ptrFromInt(high), @ptrFromInt(low), padded, width, i);
}
fn lowerBound(high: [*]const u32, low: [*]const u32, padded: usize, length: usize, width: u32, value: u32) u32 {
    var start: usize = 0;
    var end = length;
    while (start < end) {
        const mid = (start + end) / 2;
        if (atImpl(high, low, padded, width, mid) < value) start = mid + 1 else end = mid;
    }
    return @intCast(start);
}
export fn lower_bound(high: u32, index: u32, low: u32, padded: u32, superblocks: u32, high_length: u32, length: u32, width: u32, zero_count: u32, value: u32) u32 {
    _ = index;
    _ = superblocks;
    _ = high_length;
    _ = zero_count;
    return lowerBound(@ptrFromInt(high), @ptrFromInt(low), padded, length, width, value);
}
export fn at_many(high: u32, index: u32, low: u32, padded: u32, superblocks: u32, width: u32, indices_ptr: u32, output_ptr: u32, count: u32) void {
    const indices: [*]const u32 = @ptrFromInt(indices_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = at(high, index, low, padded, superblocks, width, indices[i]);
}
export fn lower_bound_many(high: u32, index: u32, low: u32, padded: u32, superblocks: u32, high_length: u32, length: u32, width: u32, zero_count: u32, values_ptr: u32, output_ptr: u32, count: u32) void {
    const values: [*]const u32 = @ptrFromInt(values_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = lower_bound(high, index, low, padded, superblocks, high_length, length, width, zero_count, values[i]);
}
export fn decode_into(high_ptr: u32, low_ptr: u32, width: u32, length: u32, output_ptr: u32) void {
    const high: [*]const u32 = @ptrFromInt(high_ptr);
    const low: [*]const u32 = @ptrFromInt(low_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    var index: usize = 0;
    var word_index: usize = 0;
    while (index < length) {
        var word = high[word_index];
        while (word != 0 and index < length) {
            const position = word_index * 32 + @ctz(word);
            out[index] = (@as(u32, @intCast(position - index)) << @intCast(width)) | lowAt(low, width, index);
            index += 1;
            word &= word - 1;
        }
        word_index += 1;
    }
}
test "low bit packing crosses words" {
    const words = [_]u32{ 0xffff_ffff, 1 };
    try std.testing.expectEqual(@as(u32, 3), lowAt(&words, 2, 15));
}
