const std = @import("std");
const U8x16 = @Vector(16, u8);

fn flush(output: []u32, low: U8x16, high: U8x16) void {
    const low_array: [16]u8 = low;
    const high_array: [16]u8 = high;
    for (0..16) |i| output[i] += low_array[i];
    for (0..16) |i| output[16 + i] += high_array[i];
}

fn addHistogram(input: []const u32, output: []u32) void {
    var low: U8x16 = @splat(0);
    var high: U8x16 = @splat(0);
    const masks: U8x16 = .{ 1, 2, 4, 8, 16, 32, 64, 128, 1, 2, 4, 8, 16, 32, 64, 128 };
    var batch: usize = 0;
    for (input) |word| {
        const bytes: [4]u8 = @bitCast(word);
        const low_bytes: U8x16 = .{ bytes[0], bytes[0], bytes[0], bytes[0], bytes[0], bytes[0], bytes[0], bytes[0], bytes[1], bytes[1], bytes[1], bytes[1], bytes[1], bytes[1], bytes[1], bytes[1] };
        const high_bytes: U8x16 = .{ bytes[2], bytes[2], bytes[2], bytes[2], bytes[2], bytes[2], bytes[2], bytes[2], bytes[3], bytes[3], bytes[3], bytes[3], bytes[3], bytes[3], bytes[3], bytes[3] };
        low += @intFromBool((low_bytes & masks) != @as(U8x16, @splat(0)));
        high += @intFromBool((high_bytes & masks) != @as(U8x16, @splat(0)));
        batch += 1;
        if (batch == 255) {
            flush(output, low, high);
            low = @splat(0);
            high = @splat(0);
            batch = 0;
        }
    }
    flush(output, low, high);
}

export fn add(input_ptr: u32, length: u32, output_ptr: u32, low_scratch: u32, high_scratch: u32) void {
    _ = low_scratch;
    _ = high_scratch;
    const input: [*]const u32 = @ptrFromInt(input_ptr);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    addHistogram(input[0..length], output[0..32]);
}

test "counts every bit position" {
    const input = [_]u32{ 1, 0x8000_0000, 0xffff_ffff };
    var output = [_]u32{0} ** 32;
    addHistogram(&input, &output);
    try std.testing.expectEqual(@as(u32, 2), output[0]);
    try std.testing.expectEqual(@as(u32, 2), output[31]);
    try std.testing.expectEqual(@as(u32, 1), output[15]);
}
