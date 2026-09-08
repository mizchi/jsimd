pub fn Export(comptime width: usize) type {
    return struct {
        const w = @import("wavelet_kernel.zig");
        export fn build(input: u32, scratch: u32, bits: u32, ranks: u32, zeros: u32, length: u32, padded: u32, superblocks: u32) void {
            w.build(width, @ptrFromInt(input), @ptrFromInt(scratch), @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), length, padded, superblocks);
        }
        export fn select(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, length: u32, value: u32, occurrence: u32) i32 {
            return w.select(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, length, value, occurrence);
        }
        export fn access(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, index: u32) u32 {
            return w.access(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, index);
        }
        export fn rank(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, value: u32, end: u32) u32 {
            return w.rank(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, value, end);
        }
        export fn count_lt(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, left: u32, right: u32, value: u32) u32 {
            return w.countLt(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, left, right, value);
        }
        export fn quantile(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, left: u32, right: u32, kth: u32) u32 {
            return w.quantile(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, left, right, kth);
        }
        export fn access_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, indices_ptr: u32, output_ptr: u32, count: u32) void {
            const indices: [*]const u32 = @ptrFromInt(indices_ptr);
            const output: [*]u32 = @ptrFromInt(output_ptr);
            for (0..count) |i| output[i] = w.access(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, indices[i]);
        }
        export fn rank_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, values_ptr: u32, ends_ptr: u32, output_ptr: u32, count: u32) void {
            const values: [*]const u32 = @ptrFromInt(values_ptr);
            const ends: [*]const u32 = @ptrFromInt(ends_ptr);
            const output: [*]u32 = @ptrFromInt(output_ptr);
            for (0..count) |i| output[i] = w.rank(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, values[i], ends[i]);
        }
        export fn quantile_many(bits: u32, ranks: u32, zeros: u32, padded: u32, superblocks: u32, lefts_ptr: u32, rights_ptr: u32, kths_ptr: u32, output_ptr: u32, count: u32) void {
            const lefts: [*]const u32 = @ptrFromInt(lefts_ptr);
            const rights: [*]const u32 = @ptrFromInt(rights_ptr);
            const kths: [*]const u32 = @ptrFromInt(kths_ptr);
            const output: [*]u32 = @ptrFromInt(output_ptr);
            for (0..count) |i| output[i] = w.quantile(width, @ptrFromInt(bits), @ptrFromInt(ranks), @ptrFromInt(zeros), padded, superblocks, lefts[i], rights[i], kths[i]);
        }
    };
}
