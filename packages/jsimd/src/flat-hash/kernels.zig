const std = @import("std");
const U8x16 = @Vector(16, u8);
inline fn hash32(v_: u32) u32 {
    var v = v_;
    v ^= v >> 16;
    v *%= 0x7feb352d;
    v ^= v >> 15;
    v *%= 0x846ca68b;
    v ^= v >> 16;
    return v;
}
inline fn hash64(key: u64) u32 {
    var h = key +% 0x9e3779b97f4a7c15;
    h = (h ^ (h >> 30)) *% 0xbf58476d1ce4e5b9;
    h = (h ^ (h >> 27)) *% 0x94d049bb133111eb;
    h ^= h >> 31;
    return @truncate(h ^ (h >> 32));
}
noinline fn mask(group: U8x16, value: u8) u16 {
    return @bitCast(group == @as(U8x16, @splat(value)));
}
const Probe = struct { slot: u32, found: bool };
fn probe(comptime K: type, controls: [*]const u8, keys: [*]const K, capacity: u32, key: K, h: u32) Probe {
    const fp: u8 = @truncate(h >> 25);
    var offset = (h & (capacity - 1)) & ~@as(u32, 15);
    var deleted: ?u32 = null;
    while (true) {
        const group: U8x16 = @as(*align(1) const U8x16, @ptrCast(controls + offset)).*;
        var matches = mask(group, fp);
        while (matches != 0) {
            const lane: u32 = @ctz(matches);
            const slot = (offset + lane) & (capacity - 1);
            if (keys[slot] == key) return .{ .slot = slot, .found = true };
            matches &= matches - 1;
        }
        if (deleted == null) {
            const d = mask(group, 254);
            if (d != 0) deleted = (offset + @as(u32, @ctz(d))) & (capacity - 1);
        }
        const empty = mask(group, 128);
        if (empty != 0) return .{ .slot = deleted orelse ((offset + @as(u32, @ctz(empty))) & (capacity - 1)), .found = false };
        offset = (offset + 16) & (capacity - 1);
    }
}
export fn init_controls(ptr: u32, capacity: u32) void {
    const c: [*]u8 = @ptrFromInt(ptr);
    for (0..capacity) |i| c[i] = 128;
}
fn insertSet(c: [*]u8, k: [*]u32, capacity: u32, key: u32) u32 {
    const p = probe(u32, c, k, capacity, key, hash32(key));
    if (p.found) return 0;
    k[p.slot] = key;
    c[p.slot] = @truncate(hash32(key) >> 25);
    return 1;
}
fn insertMap(comptime K: type, c: [*]u8, k: [*]K, v: [*]u32, capacity: u32, key: K, value: u32, h: u32) u32 {
    const p = probe(K, c, k, capacity, key, h);
    if (!p.found) {
        k[p.slot] = key;
        c[p.slot] = @truncate(h >> 25);
    }
    v[p.slot] = value;
    return @intFromBool(!p.found);
}
export fn find(c: u32, k: u32, capacity: u32, key: u32) i32 {
    const p = probe(u32, @ptrFromInt(c), @ptrFromInt(k), capacity, key, hash32(key));
    return if (p.found) @intCast(p.slot) else -1;
}
export fn insert_set(c: u32, k: u32, capacity: u32, key: u32) u32 {
    return insertSet(@ptrFromInt(c), @ptrFromInt(k), capacity, key);
}
export fn insert_map(c: u32, k: u32, v: u32, capacity: u32, key: u32, value: u32) u32 {
    return insertMap(u32, @ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, key, value, hash32(key));
}
export fn remove(c: u32, k: u32, capacity: u32, key: u32) u32 {
    const slot = find(c, k, capacity, key);
    if (slot < 0) return 0;
    const controls: [*]u8 = @ptrFromInt(c);
    controls[@intCast(slot)] = 254;
    return 1;
}
export fn lookup_many(c: u32, k: u32, capacity: u32, queries_ptr: u32, length: u32, present_ptr: u32) u32 {
    const queries: [*]const u32 = @ptrFromInt(queries_ptr);
    const present: [*]u8 = @ptrFromInt(present_ptr);
    var count: u32 = 0;
    for (0..length) |i| {
        const found = find(c, k, capacity, queries[i]) >= 0;
        present[i] = @intFromBool(found);
        count += @intFromBool(found);
    }
    return count;
}
export fn map_lookup_many(c: u32, k: u32, v: u32, capacity: u32, queries_ptr: u32, length: u32, output_ptr: u32, present_ptr: u32) u32 {
    const queries: [*]const u32 = @ptrFromInt(queries_ptr);
    const values: [*]const u32 = @ptrFromInt(v);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    const present: [*]u8 = @ptrFromInt(present_ptr);
    var count: u32 = 0;
    for (0..length) |i| {
        const slot = find(c, k, capacity, queries[i]);
        const found = slot >= 0;
        present[i] = @intFromBool(found);
        output[i] = if (found) values[@intCast(slot)] else 0;
        count += @intFromBool(found);
    }
    return count;
}
export fn insert_set_many(c: u32, k: u32, capacity: u32, input_ptr: u32, length: u32) u32 {
    const input: [*]const u32 = @ptrFromInt(input_ptr);
    var count: u32 = 0;
    for (0..length) |i| count += insertSet(@ptrFromInt(c), @ptrFromInt(k), capacity, input[i]);
    return count;
}
export fn insert_map_many(c: u32, k: u32, v: u32, capacity: u32, input_keys: u32, input_values: u32, length: u32) u32 {
    const keys: [*]const u32 = @ptrFromInt(input_keys);
    const values: [*]const u32 = @ptrFromInt(input_values);
    var count: u32 = 0;
    for (0..length) |i| count += insertMap(u32, @ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, keys[i], values[i], hash32(keys[i]));
    return count;
}
export fn rehash_set(old_c: u32, old_k: u32, old_capacity: u32, new_c: u32, new_k: u32, new_capacity: u32) void {
    const controls: [*]const u8 = @ptrFromInt(old_c);
    const keys: [*]const u32 = @ptrFromInt(old_k);
    for (0..old_capacity) |i| {
        if (controls[i] < 128) _ = insertSet(@ptrFromInt(new_c), @ptrFromInt(new_k), new_capacity, keys[i]);
    }
}
export fn rehash_map(old_c: u32, old_k: u32, old_v: u32, old_capacity: u32, new_c: u32, new_k: u32, new_v: u32, new_capacity: u32) void {
    const controls: [*]const u8 = @ptrFromInt(old_c);
    const keys: [*]const u32 = @ptrFromInt(old_k);
    const values: [*]const u32 = @ptrFromInt(old_v);
    for (0..old_capacity) |i| {
        if (controls[i] < 128) _ = insertMap(u32, @ptrFromInt(new_c), @ptrFromInt(new_k), @ptrFromInt(new_v), new_capacity, keys[i], values[i], hash32(keys[i]));
    }
}
export fn find_u64(c: u32, k: u32, capacity: u32, key: u64) i32 {
    const p = probe(u64, @ptrFromInt(c), @ptrFromInt(k), capacity, key, hash64(key));
    return if (p.found) @intCast(p.slot) else -1;
}
export fn insert_map_u64(c: u32, k: u32, v: u32, capacity: u32, key: u64, value: u32) u32 {
    return insertMap(u64, @ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, key, value, hash64(key));
}
export fn remove_u64(c: u32, k: u32, capacity: u32, key: u64) u32 {
    const slot = find_u64(c, k, capacity, key);
    if (slot < 0) return 0;
    const controls: [*]u8 = @ptrFromInt(c);
    controls[@intCast(slot)] = 254;
    return 1;
}
export fn insert_map_many_u64(c: u32, k: u32, v: u32, capacity: u32, input_keys: u32, input_values: u32, length: u32) u32 {
    const keys: [*]const u64 = @ptrFromInt(input_keys);
    const values: [*]const u32 = @ptrFromInt(input_values);
    var count: u32 = 0;
    for (0..length) |i| count += insertMap(u64, @ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, keys[i], values[i], hash64(keys[i]));
    return count;
}
export fn map_lookup_many_u64(c: u32, k: u32, v: u32, capacity: u32, queries_ptr: u32, length: u32, output_ptr: u32, present_ptr: u32) u32 {
    const queries: [*]const u64 = @ptrFromInt(queries_ptr);
    const values: [*]const u32 = @ptrFromInt(v);
    const output: [*]u32 = @ptrFromInt(output_ptr);
    const present: [*]u8 = @ptrFromInt(present_ptr);
    var count: u32 = 0;
    for (0..length) |i| {
        const slot = find_u64(c, k, capacity, queries[i]);
        const found = slot >= 0;
        present[i] = @intFromBool(found);
        output[i] = if (found) values[@intCast(slot)] else 0;
        count += @intFromBool(found);
    }
    return count;
}
export fn rehash_map_u64(old_c: u32, old_k: u32, old_v: u32, old_capacity: u32, new_c: u32, new_k: u32, new_v: u32, new_capacity: u32) void {
    const controls: [*]const u8 = @ptrFromInt(old_c);
    const keys: [*]const u64 = @ptrFromInt(old_k);
    const values: [*]const u32 = @ptrFromInt(old_v);
    for (0..old_capacity) |i| {
        if (controls[i] < 128) _ = insertMap(u64, @ptrFromInt(new_c), @ptrFromInt(new_k), @ptrFromInt(new_v), new_capacity, keys[i], values[i], hash64(keys[i]));
    }
}
test "hash fingerprints use SIMD masks" {
    try std.testing.expectEqual(@as(u16, 0xffff), mask(@splat(7), 7));
    try std.testing.expect(hash32(1) != hash32(2));
}
