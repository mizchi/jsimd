const std = @import("std");
const U32x4 = @Vector(4, u32);

inline fn mix(value_: u32) u32 {
    var value = value_;
    value ^= value >> 16;
    value *%= 0x7feb352d;
    value ^= value >> 15;
    value *%= 0x846ca68b;
    value ^= value >> 16;
    return value;
}

inline fn mix4(values: U32x4) U32x4 {
    var hashes = values;
    hashes ^= hashes >> @splat(16);
    hashes *%= @splat(0x7feb352d);
    hashes ^= hashes >> @splat(15);
    hashes *%= @splat(0x846ca68b);
    hashes ^= hashes >> @splat(16);
    return hashes;
}

fn lookupHashed(displacements: [*]const i32, fingerprints: [*]const u16, bucket_count: u32, length: u32, key: u32, first_hash: u32) i32 {
    if (length == 0) return -1;
    const displacement = displacements[first_hash % bucket_count];
    if (@as(u32, @bitCast(displacement)) == 0x8000_0000) return -1;
    const slot: u32 = if (displacement < 0)
        @intCast(-1 - @as(i64, displacement))
    else
        mix(key ^ (@as(u32, @bitCast(displacement)) *% 0x9e3779b9)) % length;
    if (fingerprints[slot] != @as(u16, @truncate(mix(key ^ 0xa5a5_a5a5)))) return -1;
    return @intCast(slot);
}

export fn lookup(displacements_ptr: u32, fingerprints_ptr: u32, bucket_count: u32, length: u32, key: u32) i32 {
    const displacements: [*]const i32 = @ptrFromInt(displacements_ptr);
    const fingerprints: [*]const u16 = @ptrFromInt(fingerprints_ptr);
    return lookupHashed(displacements, fingerprints, bucket_count, length, key, mix(key));
}

export fn lookup_many(displacements_ptr: u32, fingerprints_ptr: u32, bucket_count: u32, length: u32, queries_ptr: u32, query_count: u32, output_ptr: u32) u32 {
    const displacements: [*]const i32 = @ptrFromInt(displacements_ptr);
    const fingerprints: [*]const u16 = @ptrFromInt(fingerprints_ptr);
    const queries: [*]const u32 = @ptrFromInt(queries_ptr);
    const output: [*]i32 = @ptrFromInt(output_ptr);
    var found: u32 = 0;
    var i: usize = 0;
    while (i + 4 <= query_count) : (i += 4) {
        const keys: U32x4 = @as(*align(1) const U32x4, @ptrCast(queries + i)).*;
        const hashes = mix4(keys);
        inline for (0..4) |lane| {
            output[i + lane] = lookupHashed(displacements, fingerprints, bucket_count, length, keys[lane], hashes[lane]);
            found += @intFromBool(output[i + lane] >= 0);
        }
    }
    while (i < query_count) : (i += 1) {
        output[i] = lookupHashed(displacements, fingerprints, bucket_count, length, queries[i], mix(queries[i]));
        found += @intFromBool(output[i] >= 0);
    }
    return found;
}

test "scalar and SIMD hash lanes agree" {
    const keys: U32x4 = .{ 0, 1, 42, 0xffff_ffff };
    const hashes = mix4(keys);
    inline for (0..4) |i| try std.testing.expectEqual(mix(keys[i]), hashes[i]);
}
