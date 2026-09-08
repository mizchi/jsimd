const gear = @import("gear.zig");
const gel = @import("gel.zig");
const pixel_world = @import("pixel_world.zig");

fn gearFromParams(params: [*]const f32) gear.Gear {
    return .{
        .center_x = params[0],
        .center_y = params[1],
        .radius = params[2],
        .tooth_depth = params[3],
        .teeth = @intFromFloat(params[4]),
        .angle = params[5],
        .angular_velocity = params[6],
    };
}

export fn gear_contains(gear_params_ptr: u32, cell_x: i32, cell_y: i32) u32 {
    const params: [*]const f32 = @ptrFromInt(gear_params_ptr);
    return @intFromBool(gear.contains(gearFromParams(params), cell_x, cell_y));
}

/// All pointer ranges belong to the host-owned imported memory. The host
/// validates lengths and reserves non-overlapping regions before calling.
export fn advance_gear(
    cells_ptr: u32,
    width: u32,
    height: u32,
    gear_params_ptr: u32,
) u32 {
    const cells: [*]u32 = @ptrFromInt(cells_ptr);
    const params: [*]const f32 = @ptrFromInt(gear_params_ptr);
    const length = @as(usize, width) * @as(usize, height);
    return gear.advance(cells[0..length], width, height, gearFromParams(params));
}

export fn step_pixel_world(cells_ptr: u32, width: u32, height: u32, phase: u32) u32 {
    const cells: [*]u32 = @ptrFromInt(cells_ptr);
    const length = @as(usize, width) * @as(usize, height);
    return pixel_world.step(cells[0..length], width, height, phase);
}

/// Scans structure-of-arrays boundary coordinates four cells at a time. The
/// parameter block is [transform x/y/cos/sin, gear fields...]. A zero gear
/// tooth count disables gear collision while retaining SIMD bounds work.
export fn scan_gel_boundary(
    local_x_ptr: u32,
    local_y_ptr: u32,
    count: u32,
    params_ptr: u32,
    result_ptr: u32,
) u32 {
    const local_x: [*]const f32 = @ptrFromInt(local_x_ptr);
    const local_y: [*]const f32 = @ptrFromInt(local_y_ptr);
    const params: [*]const f32 = @ptrFromInt(params_ptr);
    const output: [*]f32 = @ptrFromInt(result_ptr);
    const transform = gel.BoundaryTransform{
        .center_x = params[0],
        .center_y = params[1],
        .cosine = params[2],
        .sine = params[3],
    };
    const active_gear = if (params[8] == 0) null else gearFromParams(params + 4);
    const result = gel.scanBoundary(local_x[0..count], local_y[0..count], transform, active_gear);
    const values = [_]f32{
        result.minimum_x,
        result.maximum_x,
        result.maximum_y,
        result.correction_x,
        result.correction_y,
        result.contact_normal_x,
        result.contact_normal_y,
        result.contact_local_x,
        result.contact_local_y,
        result.stress_delta,
    };
    for (values, 0..) |value, index| output[index] = value;
    return result.contacts;
}

/// Writes 1 for the negative crack side and 0 for the positive side. The
/// caller owns both SoA input coordinates and the byte output mask.
export fn classify_gel_fracture(
    local_x_ptr: u32,
    local_y_ptr: u32,
    sides_ptr: u32,
    count: u32,
    params_ptr: u32,
) u32 {
    const local_x: [*]const f32 = @ptrFromInt(local_x_ptr);
    const local_y: [*]const f32 = @ptrFromInt(local_y_ptr);
    const sides: [*]u8 = @ptrFromInt(sides_ptr);
    const params: [*]const f32 = @ptrFromInt(params_ptr);
    return gel.classifyFracture(
        local_x[0..count],
        local_y[0..count],
        sides[0..count],
        .{
            .normal_x = params[0],
            .normal_y = params[1],
            .tangent_x = params[2],
            .tangent_y = params[3],
            .offset = params[4],
            .cluster_id = @intFromFloat(params[5]),
        },
    );
}
