const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);

fn popcount4(value: U32x4) u32 {
    const counts: U8x16 = @popCount(@as(U8x16, @bitCast(value)));
    return @reduce(.Add, counts);
}

fn levelBits(bits: [*]u32, padded_words: usize, level: usize) [*]u32 {
    return bits + level * padded_words;
}
fn levelRanks(ranks: [*]u32, superblocks: usize, level: usize) [*]u32 {
    return ranks + level * (superblocks + 1);
}

fn buildRank(bits: [*]const u32, ranks: [*]u32, padded_words: usize, superblocks: usize) void {
    var count: u32 = 0;
    for (0..superblocks) |super| {
        ranks[super] = count;
        var word = super * 16;
        const end = @min(word + 16, padded_words);
        while (word + 4 <= end) : (word += 4) {
            const lanes: U32x4 = @as(*align(1) const U32x4, @ptrCast(bits + word)).*;
            count += popcount4(lanes);
        }
        while (word < end) : (word += 1) count += @popCount(bits[word]);
    }
    ranks[superblocks] = count;
}

pub fn build(comptime width: usize, input: [*]const u32, scratch: [*]u32, bits: [*]u32, ranks: [*]u32, zeros: [*]u32, length: usize, padded_words: usize, superblocks: usize) void {
    var current: [*]const u32 = input;
    var next: [*]u32 = scratch;
    for (0..width) |level| {
        const shift = width - 1 - level;
        const level_bits = levelBits(bits, padded_words, level);
        const level_ranks = levelRanks(ranks, superblocks, level);
        for (0..padded_words) |word| level_bits[word] = 0;
        var zero_count: usize = 0;
        for (0..length) |i| {
            const value = current[i];
            if (((value >> @intCast(shift)) & 1) != 0) level_bits[i / 32] |= @as(u32, 1) << @intCast(i & 31) else zero_count += 1;
        }
        zeros[level] = @intCast(zero_count);
        var zero_pos: usize = 0;
        var one_pos = zero_count;
        for (0..length) |i| {
            const value = current[i];
            if (((value >> @intCast(shift)) & 1) != 0) {
                next[one_pos] = value;
                one_pos += 1;
            } else {
                next[zero_pos] = value;
                zero_pos += 1;
            }
        }
        buildRank(level_bits, level_ranks, padded_words, superblocks);
        const old = current;
        current = next;
        next = @constCast(old);
    }
}

fn rank1(bits: [*]const u32, ranks: [*]const u32, padded_words: usize, superblocks: usize, level: usize, end: usize) u32 {
    const level_bits = bits + level * padded_words;
    const level_ranks = ranks + level * (superblocks + 1);
    const super = end / 512;
    var word = super * 16;
    var count = level_ranks[super];
    const full = end / 32;
    while (word + 4 <= full) : (word += 4) {
        const lanes: U32x4 = @as(*align(1) const U32x4, @ptrCast(level_bits + word)).*;
        count += popcount4(lanes);
    }
    while (word < full) : (word += 1) count += @popCount(level_bits[word]);
    const remaining = end & 31;
    if (remaining != 0) count += @popCount(level_bits[full] & ((@as(u32, 1) << @intCast(remaining)) - 1));
    return count;
}
inline fn bitAt(bits: [*]const u32, padded_words: usize, level: usize, position: usize) u32 {
    return (bits[level * padded_words + position / 32] >> @intCast(position & 31)) & 1;
}

pub fn access(comptime width: usize, bits: [*]const u32, ranks: [*]const u32, zeros: [*]const u32, padded_words: usize, superblocks: usize, index: usize) u32 {
    var position = index;
    var result: u32 = 0;
    for (0..width) |level| {
        const bit = bitAt(bits, padded_words, level, position);
        const ones = rank1(bits, ranks, padded_words, superblocks, level, position);
        if (bit != 0) {
            result |= @as(u32, 1) << @intCast(width - 1 - level);
            position = zeros[level] + ones;
        } else position -= ones;
    }
    return result;
}
pub fn rank(comptime width: usize, bits: [*]const u32, ranks: [*]const u32, zeros: [*]const u32, padded_words: usize, superblocks: usize, value: u32, end: usize) u32 {
    var left: usize = 0;
    var right = end;
    for (0..width) |level| {
        const lo = rank1(bits, ranks, padded_words, superblocks, level, left);
        const ro = rank1(bits, ranks, padded_words, superblocks, level, right);
        if (((value >> @intCast(width - 1 - level)) & 1) != 0) {
            left = zeros[level] + lo;
            right = zeros[level] + ro;
        } else {
            left -= lo;
            right -= ro;
        }
    }
    return @intCast(right - left);
}
pub fn countLt(comptime width: usize, bits: [*]const u32, ranks: [*]const u32, zeros: [*]const u32, padded_words: usize, superblocks: usize, left_start: usize, right_start: usize, value: u32) u32 {
    var left = left_start;
    var right = right_start;
    var count: u32 = 0;
    for (0..width) |level| {
        const lo = rank1(bits, ranks, padded_words, superblocks, level, left);
        const ro = rank1(bits, ranks, padded_words, superblocks, level, right);
        if (((value >> @intCast(width - 1 - level)) & 1) != 0) {
            count += @intCast((right - ro) - (left - lo));
            left = zeros[level] + lo;
            right = zeros[level] + ro;
        } else {
            left -= lo;
            right -= ro;
        }
    }
    return count;
}
pub fn quantile(comptime width: usize, bits: [*]const u32, ranks: [*]const u32, zeros: [*]const u32, padded_words: usize, superblocks: usize, left_start: usize, right_start: usize, kth_start: usize) u32 {
    var left = left_start;
    var right = right_start;
    var kth = kth_start;
    var result: u32 = 0;
    for (0..width) |level| {
        const lo = rank1(bits, ranks, padded_words, superblocks, level, left);
        const ro = rank1(bits, ranks, padded_words, superblocks, level, right);
        const zero_count = (right - ro) - (left - lo);
        if (kth < zero_count) {
            left -= lo;
            right -= ro;
        } else {
            result |= @as(u32, 1) << @intCast(width - 1 - level);
            kth -= zero_count;
            left = zeros[level] + lo;
            right = zeros[level] + ro;
        }
    }
    return result;
}
fn selectBit(bits: [*]const u32, ranks: [*]const u32, padded_words: usize, superblocks: usize, level: usize, length: usize, bit: u32, target: usize) usize {
    var low: usize = 0;
    var high = length;
    while (low < high) {
        const mid = (low + high) / 2;
        const ones = rank1(bits, ranks, padded_words, superblocks, level, mid + 1);
        const count = if (bit != 0) ones else mid + 1 - ones;
        if (count > target) high = mid else low = mid + 1;
    }
    return low;
}
pub fn select(comptime width: usize, bits: [*]const u32, ranks: [*]const u32, zeros: [*]const u32, padded_words: usize, superblocks: usize, length: usize, value: u32, occurrence: usize) i32 {
    var left: usize = 0;
    var right = length;
    for (0..width) |level| {
        const lo = rank1(bits, ranks, padded_words, superblocks, level, left);
        const ro = rank1(bits, ranks, padded_words, superblocks, level, right);
        if (((value >> @intCast(width - 1 - level)) & 1) != 0) {
            left = zeros[level] + lo;
            right = zeros[level] + ro;
        } else {
            left -= lo;
            right -= ro;
        }
    }
    if (occurrence >= right - left) return -1;
    var position = left + occurrence;
    var level = width;
    while (level > 0) {
        level -= 1;
        const bit = (value >> @intCast(width - 1 - level)) & 1;
        if (bit != 0) position -= zeros[level];
        position = selectBit(bits, ranks, padded_words, superblocks, level, length, bit, position);
    }
    return @intCast(position);
}

test "SIMD popcount is exact" {
    try std.testing.expectEqual(@as(u32, 64), popcount4(.{ 0xffff_ffff, 0xffff_ffff, 0, 0 }));
}
