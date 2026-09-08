const std = @import("std");
const U8x16 = @Vector(16, u8);
const Key = @Vector(4, u32);
inline fn mix(v_: u32) u32 {
    var v = v_;
    v ^= v >> 16;
    v *%= 0x7feb352d;
    v ^= v >> 15;
    v *%= 0x846ca68b;
    v ^= v >> 16;
    return v;
}
fn hash(key: Key) u32 {
    return mix(key[0] ^ std.math.rotl(u32, key[1], 7) ^ std.math.rotl(u32, key[2], 13) ^ std.math.rotl(u32, key[3], 21));
}
const Probe = struct { slot: u32, found: bool };
fn probe(controls: [*]const u8, keys: [*]const Key, capacity: u32, key: Key) Probe {
    const h = hash(key);
    const fingerprint: u8 = @truncate(h >> 25);
    var offset = (h & (capacity - 1)) & ~@as(u32, 15);
    var first_deleted: ?u32 = null;
    while (true) {
        const group: U8x16 = @as(*align(1) const U8x16, @ptrCast(controls + offset)).*;
        const control_array: [16]u8 = group;
        for (0..16) |lane| if (control_array[lane] == fingerprint) {
            const slot: u32 = (offset + @as(u32, @intCast(lane))) & (capacity - 1);
            if (@reduce(.And, keys[slot] == key)) return .{ .slot = slot, .found = true };
        };
        if (first_deleted == null) for (0..16) |lane| if (control_array[lane] == 254) {
            first_deleted = (offset + @as(u32, @intCast(lane))) & (capacity - 1);
            break;
        };
        for (0..16) |lane| if (control_array[lane] == 128) return .{ .slot = first_deleted orelse ((offset + @as(u32, @intCast(lane))) & (capacity - 1)), .found = false };
        offset = (offset + 16) & (capacity - 1);
    }
}
export fn init_controls(ptr: u32, capacity: u32) void {
    const controls: [*]u8 = @ptrFromInt(ptr);
    for (0..capacity) |i| controls[i] = 128;
}
export fn find(controls: u32, keys: u32, capacity: u32, key_ptr: u32) i32 {
    const result = probe(@ptrFromInt(controls), @ptrFromInt(keys), capacity, @as(*align(1) const Key, @ptrFromInt(key_ptr)).*);
    return if (result.found) @intCast(result.slot) else -1;
}
fn insert(controls: [*]u8, keys: [*]Key, values: [*]u32, capacity: u32, key: Key, value: u32) u32 {
    const result = probe(controls, keys, capacity, key);
    if (!result.found) {
        keys[result.slot] = key;
        controls[result.slot] = @truncate(hash(key) >> 25);
    }
    values[result.slot] = value;
    return @intFromBool(!result.found);
}
export fn insert_map(c: u32, k: u32, v: u32, capacity: u32, key_ptr: u32, value: u32) u32 {
    return insert(@ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, @as(*align(1) const Key, @ptrFromInt(key_ptr)).*, value);
}
export fn remove(c: u32, k: u32, capacity: u32, key_ptr: u32) u32 {
    const slot = find(c, k, capacity, key_ptr);
    if (slot < 0) return 0;
    const controls: [*]u8 = @ptrFromInt(c);
    controls[@intCast(slot)] = 254;
    return 1;
}
export fn insert_map_many(c: u32, k: u32, v: u32, capacity: u32, input_keys: u32, input_values: u32, length: u32) u32 {
    const keys: [*]const Key = @ptrFromInt(input_keys);
    const values: [*]const u32 = @ptrFromInt(input_values);
    var count: u32 = 0;
    for (0..length) |i| count += insert(@ptrFromInt(c), @ptrFromInt(k), @ptrFromInt(v), capacity, keys[i], values[i]);
    return count;
}
export fn lookup_many(c: u32, k: u32, v: u32, capacity: u32, queries: u32, length: u32, output: u32, present: u32) u32 {
    const keys: [*]const Key = @ptrFromInt(queries);
    const values: [*]const u32 = @ptrFromInt(v);
    const out: [*]u32 = @ptrFromInt(output);
    const found_out: [*]u8 = @ptrFromInt(present);
    var count: u32 = 0;
    for (0..length) |i| {
        const result = probe(@ptrFromInt(c), @ptrFromInt(k), capacity, keys[i]);
        found_out[i] = @intFromBool(result.found);
        out[i] = if (result.found) values[result.slot] else 0;
        count += @intFromBool(result.found);
    }
    return count;
}
export fn rehash_map(old_c: u32, old_k: u32, old_v: u32, old_capacity: u32, new_c: u32, new_k: u32, new_v: u32, new_capacity: u32) void {
    const controls: [*]const u8 = @ptrFromInt(old_c);
    const keys: [*]const Key = @ptrFromInt(old_k);
    const values: [*]const u32 = @ptrFromInt(old_v);
    for (0..old_capacity) |i| {
        if (controls[i] < 128) _ = insert(@ptrFromInt(new_c), @ptrFromInt(new_k), @ptrFromInt(new_v), new_capacity, keys[i], values[i]);
    }
}
test "fixed key hashing is stable" {
    try std.testing.expectEqual(hash(.{ 1, 2, 3, 4 }), hash(.{ 1, 2, 3, 4 }));
}
