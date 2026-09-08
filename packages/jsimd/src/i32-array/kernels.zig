const std = @import("std");

const I32x4 = @Vector(4, i32);
const I64x2 = @Vector(2, i64);

fn sumSlice(values: []const i32) i64 {
    var low: I64x2 = @splat(0);
    var high: I64x2 = @splat(0);
    var i: usize = 0;
    while (i + 4 <= values.len) : (i += 4) {
        const lanes: I32x4 = @as(*align(1) const I32x4, @ptrCast(values.ptr + i)).*;
        low += .{ lanes[0], lanes[1] };
        high += .{ lanes[2], lanes[3] };
    }
    var total = @reduce(.Add, low) + @reduce(.Add, high);
    while (i < values.len) : (i += 1) total += values[i];
    return total;
}

export fn sum(ptr: u32, n: u32) i64 {
    const values: [*]const i32 = @ptrFromInt(ptr);
    return sumSlice(values[0..n]);
}

fn minimum(values: []const i32) i32 {
    var best = values[0];
    var i: usize = 1;
    while (i < values.len) : (i += 1) best = @min(best, values[i]);
    return best;
}

export fn min(ptr: u32, n: u32) i32 {
    const values: [*]const i32 = @ptrFromInt(ptr);
    return minimum(values[0..n]);
}

fn maximum(values: []const i32) i32 {
    var best = values[0];
    var i: usize = 1;
    while (i < values.len) : (i += 1) best = @max(best, values[i]);
    return best;
}

export fn max(ptr: u32, n: u32) i32 {
    const values: [*]const i32 = @ptrFromInt(ptr);
    return maximum(values[0..n]);
}

fn equalSlices(left: []const i32, right: []const i32) bool {
    var i: usize = 0;
    while (i < left.len) : (i += 4) {
        const a: I32x4 = @as(*align(1) const I32x4, @ptrCast(left.ptr + i)).*;
        const b: I32x4 = @as(*align(1) const I32x4, @ptrCast(right.ptr + i)).*;
        if (@reduce(.Or, a ^ b) != 0) return false;
    }
    return true;
}

export fn equal(left_ptr: u32, right_ptr: u32, n: u32) u32 {
    const left: [*]const i32 = @ptrFromInt(left_ptr);
    const right: [*]const i32 = @ptrFromInt(right_ptr);
    return @intFromBool(equalSlices(left[0..n], right[0..n]));
}

fn addSlices(target: []i32, source: []const i32) void {
    var i: usize = 0;
    while (i < target.len) : (i += 4) {
        const a: *align(1) I32x4 = @ptrCast(target.ptr + i);
        const b: I32x4 = @as(*align(1) const I32x4, @ptrCast(source.ptr + i)).*;
        a.* +%= b;
    }
}

export fn add(target_ptr: u32, source_ptr: u32, n: u32) void {
    const target: [*]i32 = @ptrFromInt(target_ptr);
    const source: [*]const i32 = @ptrFromInt(source_ptr);
    addSlices(target[0..n], source[0..n]);
}

test "reductions and vector operations preserve signed values" {
    var values = [_]i32{ -8, 2, 9, 1, 4, 0, 0, 0 };
    const other = [_]i32{ 1, 2, 3, 4, 0, 0, 0, 0 };
    try std.testing.expectEqual(@as(i64, 4), sumSlice(values[0..4]));
    try std.testing.expectEqual(@as(i32, -8), minimum(values[0..4]));
    try std.testing.expectEqual(@as(i32, 9), maximum(values[0..4]));
    try std.testing.expect(!equalSlices(values[0..4], other[0..4]));
    addSlices(&values, &other);
    try std.testing.expectEqualSlices(i32, &[_]i32{ -7, 4, 12, 5, 4, 0, 0, 0 }, &values);
}
