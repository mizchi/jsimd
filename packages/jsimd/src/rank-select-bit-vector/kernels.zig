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
fn rank(bits: [*]const u32, index: [*]const u32, end: usize) u32 {
    const super = end / 512;
    var word = super * 16;
    var count = index[super];
    const full = end / 32;
    while (word + 4 <= full) : (word += 4) count += pop4(@as(*align(1) const U32x4, @ptrCast(bits + word)).*);
    while (word < full) : (word += 1) count += @popCount(bits[word]);
    const rem = end & 31;
    if (rem != 0) count += @popCount(bits[full] & ((@as(u32, 1) << @intCast(rem)) - 1));
    return count;
}
export fn rank1(bits: u32, index: u32, end: u32) u32 {
    return rank(@ptrFromInt(bits), @ptrFromInt(index), end);
}
fn select(bits: [*]const u32, padded_words: usize, length: usize, want_one: bool, target: usize) i32 {
    var remaining = target;
    const word_end = if (want_one) padded_words else @min(padded_words, (length + 31) / 32);
    for (0..word_end) |word_index| {
        var word = if (want_one) bits[word_index] else ~bits[word_index];
        if (!want_one and word_index * 32 + 32 > length) {
            const valid = length - word_index * 32;
            if (valid < 32) word &= (@as(u32, 1) << @intCast(valid)) - 1;
        }
        const count = @popCount(word);
        if (remaining < count) {
            while (remaining > 0) : (remaining -= 1) word &= word - 1;
            return @intCast(word_index * 32 + @ctz(word));
        }
        remaining -= count;
    }
    return -1;
}
export fn select1(bits: u32, index: u32, padded: u32, superblocks: u32, target: u32) i32 {
    _ = index;
    _ = superblocks;
    return select(@ptrFromInt(bits), padded, padded * 32, true, target);
}
export fn select0(bits: u32, index: u32, padded: u32, superblocks: u32, length: u32, target: u32) i32 {
    _ = index;
    _ = superblocks;
    return select(@ptrFromInt(bits), padded, length, false, target);
}
export fn rank1_many(bits: u32, index: u32, ends_ptr: u32, output_ptr: u32, count: u32) void {
    const ends: [*]const u32 = @ptrFromInt(ends_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = rank1(bits, index, ends[i]);
}
export fn rank0_many(bits: u32, index: u32, ends_ptr: u32, output_ptr: u32, count: u32) void {
    const ends: [*]const u32 = @ptrFromInt(ends_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = ends[i] - rank1(bits, index, ends[i]);
}
export fn select1_many(bits: u32, index: u32, padded: u32, superblocks: u32, ranks_ptr: u32, output_ptr: u32, count: u32) void {
    const ranks: [*]const u32 = @ptrFromInt(ranks_ptr);
    const out: [*]i32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = select1(bits, index, padded, superblocks, ranks[i]);
}
export fn select0_many(bits: u32, index: u32, padded: u32, superblocks: u32, length: u32, ranks_ptr: u32, output_ptr: u32, count: u32) void {
    const ranks: [*]const u32 = @ptrFromInt(ranks_ptr);
    const out: [*]i32 = @ptrFromInt(output_ptr);
    for (0..count) |i| out[i] = select0(bits, index, padded, superblocks, length, ranks[i]);
}
export fn next1(bits: u32, index: u32, padded: u32, superblocks: u32, count_ones: u32, length: u32, position_: i32) i32 {
    var position = position_;
    if (position < 0) position = 0;
    if (position >= length) return -1;
    const r = rank1(bits, index, @intCast(position));
    if (r >= count_ones) return -1;
    return select1(bits, index, padded, superblocks, r);
}
export fn prev1(bits: u32, index: u32, padded: u32, superblocks: u32, count_ones: u32, length: u32, position_: i32) i32 {
    _ = count_ones;
    if (position_ < 0 or length == 0) return -1;
    const position: u32 = @min(@as(u32, @intCast(position_)), length - 1);
    const r = rank1(bits, index, position + 1);
    if (r == 0) return -1;
    return select1(bits, index, padded, superblocks, r - 1);
}
export fn next0(bits: u32, index: u32, padded: u32, superblocks: u32, count_zeros: u32, length: u32, position_: i32) i32 {
    var position = position_;
    if (position < 0) position = 0;
    if (position >= length) return -1;
    const p: u32 = @intCast(position);
    const r = p - rank1(bits, index, p);
    if (r >= count_zeros) return -1;
    return select0(bits, index, padded, superblocks, length, r);
}
export fn prev0(bits: u32, index: u32, padded: u32, superblocks: u32, count_zeros: u32, length: u32, position_: i32) i32 {
    _ = count_zeros;
    if (position_ < 0 or length == 0) return -1;
    const position: u32 = @min(@as(u32, @intCast(position_)), length - 1);
    const end = position + 1;
    const r = end - rank1(bits, index, end);
    if (r == 0) return -1;
    return select0(bits, index, padded, superblocks, length, r - 1);
}
test "rank SIMD population count" {
    try std.testing.expectEqual(@as(u32, 64), pop4(.{ 0xffff_ffff, 0xffff_ffff, 0, 0 }));
}
