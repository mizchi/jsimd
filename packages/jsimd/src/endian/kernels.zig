const std = @import("std");

const U8x16 = @Vector(16, u8);

/// Reverse the bytes within each 32-bit word. `len` must be a multiple of four.
export fn byte_swap32(ptr: u32, len: u32) void {
    const bytes: [*]u8 = @ptrFromInt(ptr);
    byteSwap32(bytes[0..len]);
}

fn byteSwap32(bytes: []u8) void {
    var index: usize = 0;
    const length = bytes.len;

    while (index + 16 <= length) : (index += 16) {
        const chunk: *align(1) U8x16 = @ptrCast(bytes.ptr + index);
        chunk.* = @shuffle(u8, chunk.*, chunk.*, [_]i32{
            3,  2,  1,  0,
            7,  6,  5,  4,
            11, 10, 9,  8,
            15, 14, 13, 12,
        });
    }

    while (index < length) : (index += 4) {
        const word: *align(1) u32 = @ptrCast(bytes.ptr + index);
        word.* = @byteSwap(word.*);
    }
}

test "byte swap handles vector lanes and scalar tail" {
    var words = [_]u32{
        0x0123_4567,
        0x89ab_cdef,
        0x1020_3040,
        0xa0b0_c0d0,
        0x1122_3344,
    };

    byteSwap32(std.mem.sliceAsBytes(&words));

    try std.testing.expectEqualSlices(u32, &[_]u32{
        0x6745_2301,
        0xefcd_ab89,
        0x4030_2010,
        0xd0c0_b0a0,
        0x4433_2211,
    }, &words);
}
