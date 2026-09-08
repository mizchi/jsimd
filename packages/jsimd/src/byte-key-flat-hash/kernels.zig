const std = @import("std");
const U8x16 = @Vector(16, u8);
fn hashBytes(bytes: []const u8) u32 {
    var hash: u32 = 0x811c9dc5;
    for (bytes) |byte| {
        hash ^= byte;
        hash *%= 0x01000193;
    }
    hash ^= hash >> 16;
    hash *%= 0x7feb352d;
    hash ^= hash >> 15;
    hash *%= 0x846ca68b;
    hash ^= hash >> 16;
    return hash;
}
fn equalBytes(a: []const u8, b: []const u8) bool {
    var i: usize = 0;
    while (i + 16 <= a.len) : (i += 16) {
        const x: U8x16 = @as(*align(1) const U8x16, @ptrCast(a.ptr + i)).*;
        const y: U8x16 = @as(*align(1) const U8x16, @ptrCast(b.ptr + i)).*;
        if (!@reduce(.And, x == y)) return false;
    }
    return std.mem.eql(u8, a[i..], b[i..]);
}
const Probe = struct { slot: u32, found: bool };
fn probe(controls: [*]const u8, offsets: [*]const u32, lengths: [*]const u32, capacity: u32, arena: [*]const u8, key: []const u8) Probe {
    const h = hashBytes(key);
    const fp: u8 = @truncate(h >> 25);
    var offset = (h & (capacity - 1)) & ~@as(u32, 15);
    var deleted: ?u32 = null;
    while (true) {
        const group: U8x16 = @as(*align(1) const U8x16, @ptrCast(controls + offset)).*;
        const lanes: [16]u8 = group;
        for (0..16) |lane| if (lanes[lane] == fp) {
            const slot: u32 = (offset + @as(u32, @intCast(lane))) & (capacity - 1);
            if (lengths[slot] == key.len and equalBytes(arena[offsets[slot]..][0..key.len], key)) return .{ .slot = slot, .found = true };
        };
        if (deleted == null) for (0..16) |lane| if (lanes[lane] == 254) {
            deleted = (offset + @as(u32, @intCast(lane))) & (capacity - 1);
            break;
        };
        for (0..16) |lane| if (lanes[lane] == 128) return .{ .slot = deleted orelse ((offset + @as(u32, @intCast(lane))) & (capacity - 1)), .found = false };
        offset = (offset + 16) & (capacity - 1);
    }
}
export fn init_controls(ptr: u32, capacity: u32) void {
    const c: [*]u8 = @ptrFromInt(ptr);
    for (0..capacity) |i| c[i] = 128;
}
export fn find(c: u32, o: u32, l: u32, capacity: u32, a: u32, key: u32, key_len: u32) i32 {
    const bytes: [*]const u8 = @ptrFromInt(key);
    const p = probe(@ptrFromInt(c), @ptrFromInt(o), @ptrFromInt(l), capacity, @ptrFromInt(a), bytes[0..key_len]);
    return if (p.found) @intCast(p.slot) else -1;
}
fn insert(c: [*]u8, o: [*]u32, l: [*]u32, v: [*]u32, capacity: u32, arena: [*]const u8, key: []const u8, key_offset: u32, value: u32) u32 {
    const p = probe(c, o, l, capacity, arena, key);
    if (!p.found) {
        o[p.slot] = key_offset;
        l[p.slot] = @intCast(key.len);
        c[p.slot] = @truncate(hashBytes(key) >> 25);
    }
    v[p.slot] = value;
    return @intFromBool(!p.found);
}
export fn insert_map(c: u32, o: u32, l: u32, v: u32, capacity: u32, a: u32, key: u32, key_len: u32, key_offset: u32, value: u32) u32 {
    const bytes: [*]const u8 = @ptrFromInt(key);
    return insert(@ptrFromInt(c), @ptrFromInt(o), @ptrFromInt(l), @ptrFromInt(v), capacity, @ptrFromInt(a), bytes[0..key_len], key_offset, value);
}
export fn remove(c: u32, o: u32, l: u32, capacity: u32, a: u32, key: u32, key_len: u32) u32 {
    const slot = find(c, o, l, capacity, a, key, key_len);
    if (slot < 0) return 0;
    const controls: [*]u8 = @ptrFromInt(c);
    controls[@intCast(slot)] = 254;
    return 1;
}
export fn insert_map_many(c: u32, o: u32, l: u32, v: u32, capacity: u32, a: u32, base: u32, input_offsets_ptr: u32, input_values_ptr: u32, count: u32) u32 {
    const offsets: [*]const u32 = @ptrFromInt(input_offsets_ptr);
    const values: [*]const u32 = @ptrFromInt(input_values_ptr);
    const arena: [*]const u8 = @ptrFromInt(a);
    var inserted: u32 = 0;
    for (0..count) |i| {
        const start = offsets[i];
        const len = offsets[i + 1] - start;
        inserted += insert(@ptrFromInt(c), @ptrFromInt(o), @ptrFromInt(l), @ptrFromInt(v), capacity, arena, arena[base + start ..][0..len], base + start, values[i]);
    }
    return inserted;
}
export fn lookup_many(c: u32, o: u32, l: u32, v: u32, capacity: u32, a: u32, queries_ptr: u32, query_offsets_ptr: u32, count: u32, output_ptr: u32, present_ptr: u32) u32 {
    const queries: [*]const u8 = @ptrFromInt(queries_ptr);
    const offsets: [*]const u32 = @ptrFromInt(query_offsets_ptr);
    const values: [*]const u32 = @ptrFromInt(v);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    const present: [*]u8 = @ptrFromInt(present_ptr);
    var found: u32 = 0;
    for (0..count) |i| {
        const p = probe(@ptrFromInt(c), @ptrFromInt(o), @ptrFromInt(l), capacity, @ptrFromInt(a), queries[offsets[i]..offsets[i + 1]]);
        present[i] = @intFromBool(p.found);
        output[i] = if (p.found) values[p.slot] else 0;
        found += @intFromBool(p.found);
    }
    return found;
}
export fn rehash_map(old_c: u32, old_o: u32, old_l: u32, old_v: u32, old_capacity: u32, a: u32, new_c: u32, new_o: u32, new_l: u32, new_v: u32, new_capacity: u32) void {
    const controls: [*]const u8 = @ptrFromInt(old_c);
    const offsets: [*]const u32 = @ptrFromInt(old_o);
    const lengths: [*]const u32 = @ptrFromInt(old_l);
    const values: [*]const u32 = @ptrFromInt(old_v);
    const arena: [*]const u8 = @ptrFromInt(a);
    for (0..old_capacity) |i| {
        if (controls[i] < 128) _ = insert(@ptrFromInt(new_c), @ptrFromInt(new_o), @ptrFromInt(new_l), @ptrFromInt(new_v), new_capacity, arena, arena[offsets[i]..][0..lengths[i]], offsets[i], values[i]);
    }
}
test "byte hashing and SIMD equality" {
    const a = "0123456789abcdef-tail";
    try std.testing.expect(equalBytes(a, a));
    try std.testing.expect(hashBytes(a) != 0);
}
