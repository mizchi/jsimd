const std = @import("std");

const U32x4 = @Vector(4, u32);

fn materialDensity(material: u32) u32 {
    if (material == 2) return 2;
    if (material == 3) return 1;
    return 0;
}

fn fallsThrough(top: u32, bottom: u32) bool {
    const top_material = top & 0xff;
    const bottom_material = bottom & 0xff;
    if (top_material == 1 or bottom_material == 1) return false;
    return materialDensity(top_material) > materialDensity(bottom_material);
}

fn materialDensity4(material: U32x4) U32x4 {
    const sand: U32x4 = @splat(2);
    const water: U32x4 = @splat(3);
    const two: U32x4 = @splat(2);
    const one: U32x4 = @splat(1);
    const zero: U32x4 = @splat(0);
    return @select(u32, material == sand, two, @select(u32, material == water, one, zero));
}

fn verticalPass(cells: []u32, width: usize, height: usize, parity: u32) u32 {
    var moves: u32 = 0;
    var y: usize = parity;
    while (y + 1 < height) : (y += 2) {
        const top_row = y * width;
        const bottom_row = top_row + width;
        var x: usize = 0;
        while (x + 4 <= width) : (x += 4) {
            const top: *align(1) U32x4 = @ptrCast(cells.ptr + top_row + x);
            const bottom: *align(1) U32x4 = @ptrCast(cells.ptr + bottom_row + x);
            const material_mask: U32x4 = @splat(0xff);
            const wall: U32x4 = @splat(1);
            const top_material = top.* & material_mask;
            const bottom_material = bottom.* & material_mask;
            const can_fall = (top_material != wall) & (bottom_material != wall) &
                (materialDensity4(top_material) > materialDensity4(bottom_material));
            const old_top = top.*;
            const old_bottom = bottom.*;
            top.* = @select(u32, can_fall, old_bottom, old_top);
            bottom.* = @select(u32, can_fall, old_top, old_bottom);
            const mask: u4 = @bitCast(can_fall);
            moves += @popCount(mask);
        }
        while (x < width) : (x += 1) {
            const top_index = top_row + x;
            const bottom_index = bottom_row + x;
            if (!fallsThrough(cells[top_index], cells[bottom_index])) continue;
            std.mem.swap(u32, &cells[top_index], &cells[bottom_index]);
            moves += 1;
        }
    }
    return moves;
}

fn diagonalPass(cells: []u32, width: usize, height: usize, parity: u32) u32 {
    var moves: u32 = 0;
    var x: usize = parity;
    while (x + 1 < width) : (x += 2) {
        var y: usize = 0;
        while (y + 1 < height) : (y += 1) {
            const top = if (parity == 0) y * width + x else y * width + x + 1;
            const bottom = if (parity == 0) (y + 1) * width + x + 1 else (y + 1) * width + x;
            if ((cells[top] & 0xff) != 2 or !fallsThrough(cells[top], cells[bottom])) continue;
            std.mem.swap(u32, &cells[top], &cells[bottom]);
            moves += 1;
        }
    }
    return moves;
}

fn horizontalWaterPass(cells: []u32, width: usize, height: usize, parity: u32) u32 {
    var moves: u32 = 0;
    for (0..height) |y| {
        const row = y * width;
        var x: usize = parity;
        while (x + 4 <= width) : (x += 4) {
            const values: *align(1) U32x4 = @ptrCast(cells.ptr + row + x);
            const neighbors = @shuffle(u32, values.*, values.*, [_]i32{ 1, 0, 3, 2 });
            const material: U32x4 = values.* & @as(U32x4, @splat(0xff));
            const source_material = if (parity == 0)
                @shuffle(u32, material, material, [_]i32{ 1, 1, 3, 3 })
            else
                @shuffle(u32, material, material, [_]i32{ 0, 0, 2, 2 });
            const destination_material = if (parity == 0)
                @shuffle(u32, material, material, [_]i32{ 0, 0, 2, 2 })
            else
                @shuffle(u32, material, material, [_]i32{ 1, 1, 3, 3 });
            const should_swap = (source_material == @as(U32x4, @splat(3))) &
                (destination_material == @as(U32x4, @splat(0)));
            values.* = @select(u32, should_swap, neighbors, values.*);
            const mask: u4 = @bitCast(should_swap);
            moves += @popCount(mask) / 2;
        }
        while (x + 1 < width) : (x += 2) {
            const left = row + x;
            const right = left + 1;
            const source = if (parity == 0) right else left;
            const destination = if (parity == 0) left else right;
            if ((cells[source] & 0xff) != 3 or (cells[destination] & 0xff) != 0) continue;
            std.mem.swap(u32, &cells[source], &cells[destination]);
            moves += 1;
        }
    }
    return moves;
}

pub fn step(cells: []u32, width: usize, height: usize, phase: u32) u32 {
    const parity = phase & 1;
    return verticalPass(cells, width, height, parity) +
        diagonalPass(cells, width, height, parity) +
        horizontalWaterPass(cells, width, height, parity);
}

test "vertical pass swaps four independent material pairs" {
    const sand = @as(u32, 2) | (@as(u32, 200) << 8);
    const water = @as(u32, 3) | (@as(u32, 180) << 8);
    const wall = @as(u32, 1) | (@as(u32, 128) << 8);
    var cells = [_]u32{
        sand,  water, wall, 0,
        water, 0,     0,    sand,
    };

    const moves = verticalPass(&cells, 4, 2, 0);

    try std.testing.expectEqual(@as(u32, 2), moves);
    try std.testing.expectEqualSlices(u32, &[_]u32{
        water, 0,     wall, 0,
        sand,  water, 0,    sand,
    }, &cells);
}

test "horizontal water pass swaps vector pairs without losing metadata" {
    const water_a = @as(u32, 3) | (@as(u32, 17) << 8);
    const water_b = @as(u32, 3) | (@as(u32, 29) << 8);
    var cells = [_]u32{ 0, water_a, 0, water_b, 0, water_a };

    const moves = horizontalWaterPass(&cells, 6, 1, 0);

    try std.testing.expectEqual(@as(u32, 3), moves);
    try std.testing.expectEqualSlices(
        u32,
        &[_]u32{ water_a, 0, water_b, 0, water_a, 0 },
        &cells,
    );
}
