const std = @import("std");
const gear_module = @import("gear.zig");

const F32x4 = @Vector(4, f32);
const Gear = gear_module.Gear;

pub const BoundaryTransform = struct {
    center_x: f32,
    center_y: f32,
    cosine: f32,
    sine: f32,
};

pub const FracturePlane = struct {
    normal_x: f32,
    normal_y: f32,
    tangent_x: f32,
    tangent_y: f32,
    offset: f32,
    cluster_id: u32,
};

pub const BoundaryResult = struct {
    checks: u32 = 0,
    contacts: u32 = 0,
    minimum_x: f32 = std.math.inf(f32),
    maximum_x: f32 = -std.math.inf(f32),
    maximum_y: f32 = -std.math.inf(f32),
    correction_x: f32 = 0,
    correction_y: f32 = 0,
    contact_normal_x: f32 = 0,
    contact_normal_y: f32 = -1,
    contact_local_x: f32 = 0,
    contact_local_y: f32 = 0,
    stress_delta: f32 = 0,
};

fn includeBounds(result: *BoundaryResult, world_x: f32, world_y: f32) void {
    result.minimum_x = @min(result.minimum_x, world_x);
    result.maximum_x = @max(result.maximum_x, world_x);
    result.maximum_y = @max(result.maximum_y, world_y);
}

fn includeContact(
    result: *BoundaryResult,
    gear: Gear,
    world_x: f32,
    world_y: f32,
    local_x: f32,
    local_y: f32,
) void {
    const cell_x: i32 = @intFromFloat(@floor(world_x));
    const cell_y: i32 = @intFromFloat(@floor(world_y));
    if (!gear_module.contains(gear, cell_x, cell_y)) return;

    const delta_x = world_x - gear.center_x;
    const delta_y = world_y - gear.center_y;
    const distance = @max(@as(f32, 0.001), @sqrt(delta_x * delta_x + delta_y * delta_y));
    const normal_x = delta_x / distance;
    const normal_y = delta_y / distance;
    const rotation: f32 = if (gear.angular_velocity < 0) -1 else 1;
    const tangent_x = -normal_y * rotation;
    const tangent_y = normal_x * rotation;
    const surface_speed = @abs(gear.angular_velocity) * distance;

    result.correction_x += normal_x * 0.85 + tangent_x * surface_speed * 0.08;
    result.correction_y += normal_y * 0.85 + tangent_y * surface_speed * 0.08;
    result.contact_normal_x += normal_x;
    result.contact_normal_y += normal_y;
    result.contact_local_x += local_x;
    result.contact_local_y += local_y;
    result.stress_delta += 0.12 + surface_speed * 0.18;
    result.contacts += 1;
}

pub fn scanBoundary(
    local_x: []const f32,
    local_y: []const f32,
    transform: BoundaryTransform,
    gear: ?Gear,
) BoundaryResult {
    std.debug.assert(local_x.len == local_y.len);
    var result = BoundaryResult{ .checks = @intCast(local_x.len) };
    const center_x: F32x4 = @splat(transform.center_x);
    const center_y: F32x4 = @splat(transform.center_y);
    const cosine: F32x4 = @splat(transform.cosine);
    const sine: F32x4 = @splat(transform.sine);
    var index: usize = 0;

    while (index + 4 <= local_x.len) : (index += 4) {
        const xs: *align(1) const F32x4 = @ptrCast(local_x.ptr + index);
        const ys: *align(1) const F32x4 = @ptrCast(local_y.ptr + index);
        const world_x = center_x + xs.* * cosine - ys.* * sine;
        const world_y = center_y + xs.* * sine + ys.* * cosine;

        inline for (0..4) |lane| includeBounds(&result, world_x[lane], world_y[lane]);
        if (gear) |active_gear| {
            const half: F32x4 = @splat(0.5);
            const gear_x: F32x4 = @splat(active_gear.center_x);
            const gear_y: F32x4 = @splat(active_gear.center_y);
            const cell_x = @floor(world_x) + half;
            const cell_y = @floor(world_y) + half;
            const delta_x = cell_x - gear_x;
            const delta_y = cell_y - gear_y;
            const reach: F32x4 = @splat(active_gear.radius + active_gear.tooth_depth);
            const candidates = delta_x * delta_x + delta_y * delta_y <= reach * reach;
            const mask: u4 = @bitCast(candidates);
            inline for (0..4) |lane| {
                if (mask & (@as(u4, 1) << lane) != 0) {
                    includeContact(
                        &result,
                        active_gear,
                        world_x[lane],
                        world_y[lane],
                        xs.*[lane],
                        ys.*[lane],
                    );
                }
            }
        }
    }

    while (index < local_x.len) : (index += 1) {
        const x = local_x[index];
        const y = local_y[index];
        const world_x = transform.center_x + x * transform.cosine - y * transform.sine;
        const world_y = transform.center_y + x * transform.sine + y * transform.cosine;
        includeBounds(&result, world_x, world_y);
        if (gear) |active_gear| includeContact(&result, active_gear, world_x, world_y, x, y);
    }
    return result;
}

fn crackNoise(tangent_position: f32, cluster_id: u32) f32 {
    const seed = @as(f32, @floatFromInt(cluster_id)) * 0.731;
    return @sin(tangent_position * 0.32 + seed) * 1.55 +
        @sin(tangent_position * 0.13 - seed * 0.7) * 0.8;
}

pub fn classifyFracture(
    local_x: []const f32,
    local_y: []const f32,
    sides: []u8,
    plane: FracturePlane,
) u32 {
    std.debug.assert(local_x.len == local_y.len and local_x.len == sides.len);
    const normal_x: F32x4 = @splat(plane.normal_x);
    const normal_y: F32x4 = @splat(plane.normal_y);
    const tangent_x: F32x4 = @splat(plane.tangent_x);
    const tangent_y: F32x4 = @splat(plane.tangent_y);
    const offset: F32x4 = @splat(plane.offset);
    var negative_count: u32 = 0;
    var index: usize = 0;

    while (index + 4 <= local_x.len) : (index += 4) {
        const xs: *align(1) const F32x4 = @ptrCast(local_x.ptr + index);
        const ys: *align(1) const F32x4 = @ptrCast(local_y.ptr + index);
        const tangent_position = xs.* * tangent_x + ys.* * tangent_y;
        const signed_distance = xs.* * normal_x + ys.* * normal_y - offset;
        inline for (0..4) |lane| {
            const negative = signed_distance[lane] +
                crackNoise(tangent_position[lane], plane.cluster_id) < 0;
            sides[index + lane] = @intFromBool(negative);
            negative_count += @intFromBool(negative);
        }
    }

    while (index < local_x.len) : (index += 1) {
        const tangent_position = local_x[index] * plane.tangent_x + local_y[index] * plane.tangent_y;
        const signed_distance = local_x[index] * plane.normal_x + local_y[index] * plane.normal_y -
            plane.offset + crackNoise(tangent_position, plane.cluster_id);
        const negative = signed_distance < 0;
        sides[index] = @intFromBool(negative);
        negative_count += @intFromBool(negative);
    }
    return negative_count;
}

test "boundary scan transforms four lanes and reports world bounds" {
    const local_x = [_]f32{ -2, -1, 1, 2 };
    const local_y = [_]f32{ 1, -3, 4, 0 };
    const result = scanBoundary(
        &local_x,
        &local_y,
        .{ .center_x = 10, .center_y = 20, .cosine = 1, .sine = 0 },
        null,
    );

    try std.testing.expectEqual(@as(u32, 4), result.checks);
    try std.testing.expectEqual(@as(u32, 0), result.contacts);
    try std.testing.expectApproxEqAbs(@as(f32, 8), result.minimum_x, 0.0001);
    try std.testing.expectApproxEqAbs(@as(f32, 12), result.maximum_x, 0.0001);
    try std.testing.expectApproxEqAbs(@as(f32, 24), result.maximum_y, 0.0001);
}

test "fracture classification writes a side byte for vector lanes and tail" {
    const local_x = [_]f32{ -100, -50, 50, 100, 120 };
    const local_y = [_]f32{ 0, 0, 0, 0, 0 };
    var sides = [_]u8{0} ** local_x.len;
    const negative_count = classifyFracture(
        &local_x,
        &local_y,
        &sides,
        .{
            .normal_x = 1,
            .normal_y = 0,
            .tangent_x = 0,
            .tangent_y = 1,
            .offset = 0,
            .cluster_id = 1,
        },
    );

    try std.testing.expectEqual(@as(u32, 2), negative_count);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 1, 1, 0, 0, 0 }, &sides);
}
