const std = @import("std");
const U32x4 = @Vector(4, u32);
const U8x16 = @Vector(16, u8);

fn popcount(value: U32x4) u32 {
    const bytes: U8x16 = @bitCast(value);
    const counts: U8x16 = @popCount(bytes);
    return @reduce(.Add, counts);
}

export fn row_count(row_ptr: u32, padded_words: u32) u32 {
    const row: [*]const U32x4 = @ptrFromInt(row_ptr);
    var count: u32 = 0;
    for (0..padded_words / 4) |i| count += popcount(row[i]);
    return count;
}

export fn transpose(input_ptr: u32, output_ptr: u32, rows: u32, columns: u32, input_stride: u32, output_stride: u32) void {
    const input: [*]const u32 = @ptrFromInt(input_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    for (0..rows) |row| for (0..columns) |column| {
        if ((input[row * input_stride + column / 32] & (@as(u32, 1) << @intCast(column & 31))) != 0)
            output[column * output_stride + row / 32] |= @as(u32, 1) << @intCast(row & 31);
    };
}

export fn boolean_multiply(left_ptr: u32, right_ptr: u32, output_ptr: u32, rows: u32, columns: u32, shared_words: u32, left_stride: u32, right_stride: u32, output_stride: u32) void {
    const left: [*]const U32x4 = @ptrFromInt(left_ptr);
    const right: [*]const U32x4 = @ptrFromInt(right_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    for (0..rows) |row| for (0..columns) |column| {
        var found = false;
        var word: usize = 0;
        while (word < shared_words) : (word += 4) {
            const lane = word / 4;
            if (@reduce(.Or, left[(row * left_stride) / 4 + lane] & right[(column * right_stride) / 4 + lane]) != 0) {
                found = true;
                break;
            }
        }
        if (found) output[row * output_stride + column / 32] |= @as(u32, 1) << @intCast(column & 31);
    };
}

export fn sparse_has(offsets_ptr: u32, values_ptr: u32, row: u32, target: u32) u32 {
    const offsets: [*]const u32 = @ptrFromInt(offsets_ptr);
    const values: [*]const u32 = @ptrFromInt(values_ptr);
    var low = offsets[row];
    var high = offsets[row + 1];
    while (low < high) {
        const middle = low + (high - low) / 2;
        const value = values[middle];
        if (value == target) return 1;
        if (value < target) low = middle + 1 else high = middle;
    }
    return 0;
}

test "horizontal population count" {
    try std.testing.expectEqual(@as(u32, 64), popcount(.{ 0xffff_ffff, 0, 0xaaaa_aaaa, 0x5555_5555 }));
}
