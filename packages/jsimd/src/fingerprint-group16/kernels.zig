const std = @import("std");

const U8x16 = @Vector(16, u8);
const empty_control: u8 = 0x80;
const deleted_control: u8 = 0xfe;

noinline fn matchMask(control: U8x16, fingerprint: u8) u16 {
    const matches = control == @as(U8x16, @splat(fingerprint));
    return @bitCast(matches);
}

fn loadGroup(pointer: [*]const u8) U8x16 {
    const group: *align(1) const U8x16 = @ptrCast(pointer);
    return group.*;
}

export fn match_mask(group_ptr: u32, fingerprint: u32) u32 {
    const group: [*]const u8 = @ptrFromInt(group_ptr);
    return matchMask(loadGroup(group), @truncate(fingerprint));
}

export fn empty_mask(group_ptr: u32) u32 {
    const group: [*]const u8 = @ptrFromInt(group_ptr);
    return matchMask(loadGroup(group), empty_control);
}

export fn deleted_mask(group_ptr: u32) u32 {
    const group: [*]const u8 = @ptrFromInt(group_ptr);
    return matchMask(loadGroup(group), deleted_control);
}

fn matchMany(control: U8x16, fingerprints: []const u8, output: []u16) void {
    for (fingerprints, output) |fingerprint, *result| result.* = matchMask(control, fingerprint);
}

export fn match_many(group_ptr: u32, fingerprints_ptr: u32, output_ptr: u32, length: u32) void {
    const group: [*]const u8 = @ptrFromInt(group_ptr);
    const fingerprints: [*]const u8 = @ptrFromInt(fingerprints_ptr);
    const output: [*]u16 = @ptrFromInt(output_ptr);
    matchMany(loadGroup(group), fingerprints[0..length], output[0..length]);
}

fn tableProbeMany(
    controls: []const u8,
    hashes: []const u32,
    groups: []u32,
    matches: []u16,
    empty: []u16,
    deleted: []u16,
) void {
    const capacity: u32 = @intCast(controls.len);
    for (hashes, 0..) |hash, index| {
        const offset = (hash & (capacity - 1)) & ~@as(u32, 15);
        const group = loadGroup(controls.ptr + offset);
        groups[index] = offset;
        matches[index] = matchMask(group, @truncate(hash >> 25));
        empty[index] = matchMask(group, empty_control);
        deleted[index] = matchMask(group, deleted_control);
    }
}

export fn table_probe_many(
    controls_ptr: u32,
    capacity: u32,
    hashes_ptr: u32,
    groups_ptr: u32,
    matches_ptr: u32,
    empty_ptr: u32,
    deleted_ptr: u32,
    length: u32,
) void {
    const controls: [*]const u8 = @ptrFromInt(controls_ptr);
    const hashes: [*]const u32 = @ptrFromInt(hashes_ptr);
    const groups: [*]u32 = @ptrFromInt(groups_ptr);
    const matches: [*]u16 = @ptrFromInt(matches_ptr);
    const empty: [*]u16 = @ptrFromInt(empty_ptr);
    const deleted: [*]u16 = @ptrFromInt(deleted_ptr);
    tableProbeMany(
        controls[0..capacity],
        hashes[0..length],
        groups[0..length],
        matches[0..length],
        empty[0..length],
        deleted[0..length],
    );
}

test "control masks and batched table probes preserve lane positions" {
    const control = U8x16{ 7, 1, 7, 0x80, 0xfe, 7, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
    try std.testing.expectEqual(@as(u16, 0b0000_0100_0010_0101), matchMask(control, 7));
    try std.testing.expectEqual(@as(u16, 1 << 3), matchMask(control, empty_control));

    var controls = [_]u8{empty_control} ** 64;
    controls[1] = 7;
    controls[18] = 7;
    controls[19] = 3;
    controls[33] = 7;
    const hashes = [_]u32{ (7 << 25) | 1, (7 << 25) | 18, (3 << 25) | 19, (9 << 25) | 33 };
    var groups: [4]u32 = undefined;
    var matches: [4]u16 = undefined;
    var empty: [4]u16 = undefined;
    var deleted: [4]u16 = undefined;
    tableProbeMany(&controls, &hashes, &groups, &matches, &empty, &deleted);
    try std.testing.expectEqualSlices(u32, &[_]u32{ 0, 16, 16, 32 }, &groups);
    try std.testing.expectEqualSlices(u16, &[_]u16{ 2, 4, 8, 0 }, &matches);
}
