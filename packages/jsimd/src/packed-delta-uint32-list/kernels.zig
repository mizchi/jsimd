const std = @import("std");
const U32x4 = @Vector(4, u32);
export fn init_shuffle_table(table_ptr: u32) void {
    const table: [*]u8 = @ptrFromInt(table_ptr);
    for (0..256) |control| {
        var offset: u8 = 0;
        for (0..4) |lane| {
            const length: u8 = @intCast(((control >> @as(u3, @intCast(lane * 2))) & 3) + 1);
            for (0..4) |byte| table[control * 16 + lane * 4 + byte] = if (byte < length) offset + @as(u8, @intCast(byte)) else 128;
            offset += length;
        }
    }
}
inline fn dataLength(control: u8) usize {
    return 4 + (control & 3) + ((control >> 2) & 3) + ((control >> 4) & 3) + ((control >> 6) & 3);
}
fn decodeGroup(data: [*]const u8, control: u8, base: u32) U32x4 {
    var deltas = [_]u32{0} ** 4;
    var offset: usize = 0;
    for (0..4) |lane| {
        const length: usize = ((control >> @as(u3, @intCast(lane * 2))) & 3) + 1;
        var value: u32 = 0;
        for (0..length) |byte| value |= @as(u32, data[offset + byte]) << @intCast(byte * 8);
        deltas[lane] = value;
        offset += length;
    }
    const d: U32x4 = deltas;
    const p1 = d + @shuffle(u32, @as(U32x4, @splat(0)), d, @Vector(4, i32){ 0, -1, -2, -3 });
    const p2 = p1 + @shuffle(u32, @as(U32x4, @splat(0)), p1, @Vector(4, i32){ 0, 1, -1, -2 });
    return p2 + @as(U32x4, @splat(base));
}
fn at32(data: [*]const u8, controls: [*]const u8, checkpoints: [*]const u32, index: usize) u32 {
    const block = index / 128;
    const target = (index & 127) / 4;
    const lane = index & 3;
    const group = block * 32;
    var offset: usize = checkpoints[block * 2];
    var base = checkpoints[block * 2 + 1];
    for (0..target + 1) |g| {
        const control = controls[group + g];
        const values: [4]u32 = decodeGroup(data + offset, control, base);
        if (g == target) return values[lane];
        base = values[3];
        offset += dataLength(control);
    }
    unreachable;
}
export fn at(data: u32, controls: u32, checkpoints: u32, index: u32) u64 {
    return at32(@ptrFromInt(data), @ptrFromInt(controls), @ptrFromInt(checkpoints), index);
}
export fn lower_bound(data: u32, controls: u32, checkpoints: u32, length: u32, target: u32) u32 {
    var low: usize = 0;
    var high: usize = length;
    while (low < high) {
        const mid = (low + high) / 2;
        if (at32(@ptrFromInt(data), @ptrFromInt(controls), @ptrFromInt(checkpoints), mid) < target) low = mid + 1 else high = mid;
    }
    return @intCast(low);
}
export fn decode_range(data: u32, controls: u32, checkpoints: u32, length: u32, start: u32, output_ptr: u32, output_length: u32) u32 {
    if (start >= length) return 0;
    const output: [*]u32 = @ptrFromInt(output_ptr);
    const count = @min(output_length, length - start);
    for (0..count) |i| output[i] = at32(@ptrFromInt(data), @ptrFromInt(controls), @ptrFromInt(checkpoints), start + i);
    return count;
}
const Cursor = struct {
    data: [*]const u8,
    controls: [*]const u8,
    length: usize,
    position: usize = 0,
    group: usize = 0,
    offset: usize = 0,
    base: u32 = 0,
    values: [4]u32 = undefined,
    lane: usize = 4,
    fn peek(self: *Cursor) ?u32 {
        if (self.position >= self.length) return null;
        if (self.lane >= 4) {
            const control = self.controls[self.group];
            self.values = decodeGroup(self.data + self.offset, control, self.base);
            self.offset += dataLength(control);
            self.base = self.values[3];
            self.group += 1;
            self.lane = 0;
        }
        return self.values[self.lane];
    }
    fn advance(self: *Cursor) void {
        self.position += 1;
        self.lane += 1;
    }
};
export fn intersect_into(left_data: u32, left_controls: u32, left_length: u32, right_data: u32, right_controls: u32, right_length: u32, output_ptr: u32, output_length: u32) u32 {
    const output: [*]u32 = @ptrFromInt(output_ptr);
    var left = Cursor{ .data = @ptrFromInt(left_data), .controls = @ptrFromInt(left_controls), .length = left_length };
    var right = Cursor{ .data = @ptrFromInt(right_data), .controls = @ptrFromInt(right_controls), .length = right_length };
    var written: usize = 0;
    while (written < output_length) {
        const a = left.peek() orelse break;
        const b = right.peek() orelse break;
        if (a == b) {
            output[written] = a;
            written += 1;
            left.advance();
            right.advance();
        } else if (a < b) left.advance() else right.advance();
    }
    return @intCast(written);
}
test "group decoding uses SIMD prefix sums" {
    const data = [_]u8{ 1, 2, 3, 4 } ++ [_]u8{0} ** 12;
    const values: [4]u32 = decodeGroup(&data, 0, 10);
    try std.testing.expectEqualSlices(u32, &[_]u32{ 11, 13, 16, 20 }, &values);
}
