const std = @import("std");

pub const Gear = struct {
    center_x: f32,
    center_y: f32,
    radius: f32,
    tooth_depth: f32,
    teeth: u32,
    angle: f32,
    angular_velocity: f32,
};

pub fn contains(gear: Gear, cell_x: i32, cell_y: i32) bool {
    const delta_x = @as(f32, @floatFromInt(cell_x)) + 0.5 - gear.center_x;
    const delta_y = @as(f32, @floatFromInt(cell_y)) + 0.5 - gear.center_y;
    const distance_squared = delta_x * delta_x + delta_y * delta_y;
    const reach = gear.radius + gear.tooth_depth;
    if (distance_squared > reach * reach) return false;

    const direction = std.math.atan2(delta_y, delta_x);
    const teeth: f32 = @floatFromInt(gear.teeth);
    const wave = (@cos((direction - gear.angle) * teeth) + 1) * 0.5;
    const wave_squared = wave * wave;
    const outer_radius = gear.radius + gear.tooth_depth * wave_squared * wave_squared;
    return distance_squared <= outer_radius * outer_radius;
}

fn jsRoundToI32(value: f32) i32 {
    return @intFromFloat(@floor(value + 0.5));
}

fn findDestination(
    cells: []const u32,
    width: usize,
    height: usize,
    gear: Gear,
    source_x: i32,
    source_y: i32,
) ?usize {
    const delta_x = @as(f32, @floatFromInt(source_x)) + 0.5 - gear.center_x;
    const delta_y = @as(f32, @floatFromInt(source_y)) + 0.5 - gear.center_y;
    const radius = @sqrt(delta_x * delta_x + delta_y * delta_y);
    const normal_x: f32 = if (radius == 0) 0 else delta_x / radius;
    const normal_y: f32 = if (radius == 0) -1 else delta_y / radius;
    const rotation: f32 = if (gear.angular_velocity < 0) -1 else 1;
    const tangent_x = -normal_y * rotation;
    const tangent_y = normal_x * rotation;
    const tangential_travel: i32 = @max(1, @as(i32, @intFromFloat(@ceil(
        @abs(gear.angular_velocity) * (gear.radius + gear.tooth_depth),
    ))));
    const search_distance: i32 = @intFromFloat(@ceil(
        gear.radius + gear.tooth_depth + @as(f32, @floatFromInt(tangential_travel)) + 2,
    ));
    var distance: i32 = 1;
    while (distance <= search_distance) : (distance += 1) {
        const travel = @min(distance, tangential_travel);
        const distance_f: f32 = @floatFromInt(distance);
        const travel_f: f32 = @floatFromInt(travel);
        const outward_scales = [_]f32{ 0.65, 1, 0.35 };
        for (outward_scales) |scale| {
            const outward = distance_f * scale;
            const x = jsRoundToI32(
                @as(f32, @floatFromInt(source_x)) + tangent_x * travel_f + normal_x * outward,
            );
            const y = jsRoundToI32(
                @as(f32, @floatFromInt(source_y)) + tangent_y * travel_f + normal_y * outward,
            );
            if (x < 0 or y < 0 or x >= width or y >= height) continue;
            const destination = @as(usize, @intCast(y)) * width + @as(usize, @intCast(x));
            if ((cells[destination] & 0xff) == 0 and !contains(gear, x, y)) return destination;
        }
    }
    return null;
}

pub fn advance(cells: []u32, width: usize, height: usize, gear: Gear) u32 {
    const reach = gear.radius + gear.tooth_depth;
    const start_x: i32 = @max(0, @as(i32, @intFromFloat(@floor(gear.center_x - reach - 1))));
    const end_x: i32 = @min(
        @as(i32, @intCast(width - 1)),
        @as(i32, @intFromFloat(@ceil(gear.center_x + reach + 1))),
    );
    const start_y: i32 = @max(0, @as(i32, @intFromFloat(@floor(gear.center_y - reach - 1))));
    const end_y: i32 = @min(
        @as(i32, @intCast(height - 1)),
        @as(i32, @intFromFloat(@ceil(gear.center_y + reach + 1))),
    );
    var moves: u32 = 0;
    var y = start_y;
    while (y <= end_y) : (y += 1) {
        var x = start_x;
        while (x <= end_x) : (x += 1) {
            const source = @as(usize, @intCast(y)) * width + @as(usize, @intCast(x));
            const material = cells[source] & 0xff;
            if ((material != 2 and material != 3) or !contains(gear, x, y)) continue;
            const destination = findDestination(cells, width, height, gear, x, y) orelse continue;
            cells[destination] = cells[source];
            cells[source] = 0;
            moves += 1;
        }
    }
    return moves;
}

test "gear geometry distinguishes its body from outside cells" {
    const gear = Gear{
        .center_x = 20,
        .center_y = 17,
        .radius = 7,
        .tooth_depth = 3,
        .teeth = 10,
        .angle = 0,
        .angular_velocity = 0.16,
    };
    try std.testing.expect(contains(gear, 20, 17));
    try std.testing.expect(!contains(gear, 0, 0));
}

test "destination rounding matches JavaScript Math.round at negative halves" {
    try std.testing.expectEqual(@as(i32, 0), jsRoundToI32(-0.5));
    try std.testing.expectEqual(@as(i32, -1), jsRoundToI32(-1.5));
    try std.testing.expectEqual(@as(i32, 2), jsRoundToI32(1.5));
}

test "gear advance moves a complete packed material cell" {
    const width = 40;
    const height = 32;
    var cells = [_]u32{0} ** (width * height);
    const gear = Gear{
        .center_x = 20,
        .center_y = 17,
        .radius = 7,
        .tooth_depth = 3,
        .teeth = 10,
        .angle = 0.16,
        .angular_velocity = 0.16,
    };
    var source: ?usize = null;
    for (0..height) |y| {
        for (0..width) |x| {
            if (!contains(gear, @intCast(x), @intCast(y))) continue;
            source = y * width + x;
            break;
        }
        if (source != null) break;
    }
    const packed_sand = @as(u32, 2) | (@as(u32, 200) << 8) | (@as(u32, 7) << 16) |
        (@as(u32, 11) << 24);
    cells[source.?] = packed_sand;

    const moves = advance(&cells, width, height, gear);

    try std.testing.expectEqual(@as(u32, 1), moves);
    try std.testing.expectEqual(@as(u32, 0), cells[source.?]);
    var found = false;
    for (cells) |cell| {
        if (cell == packed_sand) found = true;
    }
    try std.testing.expect(found);
}
