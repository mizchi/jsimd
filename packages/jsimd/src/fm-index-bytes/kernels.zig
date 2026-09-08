const w = @import("wavelet");
export fn build(input: u32, scratch: u32, bits: u32, ranks: u32, zeros: u32, length: u32, padded: u32, superblocks: u32) void {
    w.build(8, @ptrFromInt(input), @ptrFromInt(scratch), @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), length, padded, superblocks);
}
export fn select(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, length: u32, value: u32, occurrence: u32) i32 {
    return w.select(8, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, length, value, occurrence);
}
export fn access(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, index: u32) u32 {
    return w.access(8, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, index);
}
export fn rank(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, value: u32, end: u32) u32 {
    return w.rank(8, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, value, end);
}
export fn count_lt(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, left: u32, right: u32, value: u32) u32 {
    return w.countLt(8, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, left, right, value);
}
export fn quantile(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, left: u32, right: u32, kth: u32) u32 {
    return w.quantile(8, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, left, right, kth);
}
export fn access_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, indices_ptr: u32, output_ptr: u32, n: u32) void {
    const indices: [*]const u32 = @ptrFromInt(indices_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..n) |i| out[i] = access(bits, ranks, zeros, padded, superblocks, indices[i]);
}
export fn rank_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, values_ptr: u32, ends_ptr: u32, output_ptr: u32, n: u32) void {
    const values: [*]const u32 = @ptrFromInt(values_ptr);
    const ends: [*]const u32 = @ptrFromInt(ends_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..n) |i| out[i] = rank(bits, ranks, zeros, padded, superblocks, values[i], ends[i]);
}
export fn quantile_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, lefts_ptr: u32, rights_ptr: u32, kths_ptr: u32, output_ptr: u32, n: u32) void {
    const lefts: [*]const u32 = @ptrFromInt(lefts_ptr);
    const rights: [*]const u32 = @ptrFromInt(rights_ptr);
    const kths: [*]const u32 = @ptrFromInt(kths_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..n) |i| out[i] = quantile(bits, ranks, zeros, padded, superblocks, lefts[i], rights[i], kths[i]);
}
fn occ(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, sentinel: u32, value: u32, end: u32) u32 {
    var result = rank(bits, ranks, zeros, padded, superblocks, value, end);
    if (value == 0 and sentinel < end) result -= 1;
    return result;
}
fn interval(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative: [*]const u32, sentinel: u32, text_length: u32, pattern: []const u8) struct { left: u32, right: u32 } {
    var left: u32 = 0;
    var right = text_length + 1;
    var i = pattern.len;
    while (i > 0) {
        i -= 1;
        const value = pattern[i];
        const base = cumulative[value];
        left = base + occ(bits, ranks, zeros, padded, superblocks, sentinel, value, left);
        right = base + occ(bits, ranks, zeros, padded, superblocks, sentinel, value, right);
        if (left >= right) return .{ .left = left, .right = left };
    }
    return .{ .left = left, .right = right };
}
export fn count(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative_ptr: u32, sentinel: u32, text_length: u32, pattern_ptr: u32, pattern_length: u32) u32 {
    const pattern: [*]const u8 = @ptrFromInt(pattern_ptr);
    const range = interval(bits, ranks, zeros, padded, superblocks, @ptrFromInt(cumulative_ptr), sentinel, text_length, pattern[0..pattern_length]);
    return range.right - range.left;
}
export fn count_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative: u32, sentinel: u32, text_length: u32, patterns_ptr: u32, offsets_ptr: u32, query_count: u32, output_ptr: u32) void {
    const patterns: [*]const u8 = @ptrFromInt(patterns_ptr);
    const offsets: [*]const u32 = @ptrFromInt(offsets_ptr);
    const out: [*]u32 = @ptrFromInt(output_ptr);
    for (0..query_count) |i| out[i] = count(bits, ranks, zeros, padded, superblocks, cumulative, sentinel, text_length, @intCast(@intFromPtr(patterns + offsets[i])), offsets[i + 1] - offsets[i]);
}
fn lf(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative: [*]const u32, sentinel: u32, row: u32) u32 {
    if (row == sentinel) return 0;
    const value = access(bits, ranks, zeros, padded, superblocks, row);
    return cumulative[value] + occ(bits, ranks, zeros, padded, superblocks, sentinel, value, row);
}
fn rawBit(bits: [*]const u32, row: u32) bool {
    return ((bits[row / 32] >> @intCast(row & 31)) & 1) != 0;
}
fn rawRank(bits: [*]const u32, end: u32) u32 {
    var result: u32 = 0;
    for (0..end / 32) |i| result += @popCount(bits[i]);
    const rem = end & 31;
    if (rem != 0) result += @popCount(bits[end / 32] & ((@as(u32, 1) << @intCast(rem)) - 1));
    return result;
}
fn locateRow(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative: [*]const u32, sentinel: u32, text_length: u32, sample_bits: [*]const u32, sample_values: [*]const u32, row_start: u32) u32 {
    var row = row_start;
    var steps: u32 = 0;
    while (!rawBit(sample_bits, row)) {
        row = lf(bits, ranks, zeros, padded, superblocks, cumulative, sentinel, row);
        steps += 1;
    }
    const sample_index = rawRank(sample_bits, row);
    var position = sample_values[sample_index] + steps;
    if (position > text_length) position -= text_length + 1;
    return position;
}
export fn locate_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, cumulative_ptr: u32, sentinel: u32, text_length: u32, sample_bits_ptr: u32, sample_ranks: u32, sample_values_ptr: u32, patterns_ptr: u32, offsets_ptr: u32, query_count: u32, result_offsets_ptr: u32, output_ptr: u32) void {
    _ = sample_ranks;
    const cumulative: [*]const u32 = @ptrFromInt(cumulative_ptr);
    const patterns: [*]const u8 = @ptrFromInt(patterns_ptr);
    const offsets: [*]const u32 = @ptrFromInt(offsets_ptr);
    const result_offsets: [*]const u32 = @ptrFromInt(result_offsets_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    for (0..query_count) |q| {
        const range = interval(bits, ranks, zeros, padded, superblocks, cumulative, sentinel, text_length, patterns[offsets[q]..offsets[q + 1]]);
        var row = range.left;
        var out = result_offsets[q];
        while (row < range.right) : (row += 1) {
            output[out] = locateRow(bits, ranks, zeros, padded, superblocks, cumulative, sentinel, text_length, @ptrFromInt(sample_bits_ptr), @ptrFromInt(sample_values_ptr), row);
            out += 1;
        }
    }
}
