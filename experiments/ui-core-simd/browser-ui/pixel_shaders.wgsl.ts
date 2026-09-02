export const pixelComputeShader = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  parity: u32,
  pairCount: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  padding3: u32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;

fn material(cell: u32) -> u32 {
  return cell & 0xffu;
}

fn density(value: u32) -> u32 {
  if (value == 2u) { return 2u; }
  if (value == 3u) { return 1u; }
  return 0u;
}

fn fallsThrough(top: u32, bottom: u32) -> bool {
  let topMaterial = material(top);
  let bottomMaterial = material(bottom);
  return topMaterial != 1u && bottomMaterial != 1u &&
    density(topMaterial) > density(bottomMaterial);
}

fn swapPair(first: u32, second: u32) {
  let value = cells[first];
  cells[first] = cells[second];
  cells[second] = value;
}

@compute @workgroup_size(64)
fn vertical(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.pairCount) { return; }
  let x = id.x % params.width;
  let pairRow = id.x / params.width;
  let y = params.parity + pairRow * 2u;
  let top = y * params.width + x;
  let bottom = top + params.width;
  if (fallsThrough(cells[top], cells[bottom])) { swapPair(top, bottom); }
}

@compute @workgroup_size(64)
fn diagonal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.pairCount) { return; }
  let pairedColumns = (params.width - params.parity) / 2u;
  let pairColumn = id.x % pairedColumns;
  let y = id.x / pairedColumns;
  let x = params.parity + pairColumn * 2u;
  var top = y * params.width + x;
  var bottom = (y + 1u) * params.width + x + 1u;
  if (params.parity == 1u) {
    top = y * params.width + x + 1u;
    bottom = (y + 1u) * params.width + x;
  }
  if (material(cells[top]) == 2u && fallsThrough(cells[top], cells[bottom])) {
    swapPair(top, bottom);
  }
}

@compute @workgroup_size(64)
fn horizontal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.pairCount) { return; }
  let pairedColumns = (params.width - params.parity) / 2u;
  let pairColumn = id.x % pairedColumns;
  let y = id.x / pairedColumns;
  let left = y * params.width + params.parity + pairColumn * 2u;
  let right = left + 1u;
  let source = select(right, left, params.parity == 1u);
  let destination = select(left, right, params.parity == 1u);
  if (material(cells[source]) == 3u && material(cells[destination]) == 0u) {
    swapPair(source, destination);
  }
}
`;

export const pixelBrushShader = /* wgsl */ `
struct BrushParams {
  width: u32,
  height: u32,
  centerX: u32,
  centerY: u32,
  radius: u32,
  material: u32,
  diameter: u32,
  count: u32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> brush: BrushParams;

@compute @workgroup_size(64)
fn paint(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= brush.count) { return; }
  let localX = id.x % brush.diameter;
  let localY = id.x / brush.diameter;
  let signedX = i32(brush.centerX) + i32(localX) - i32(brush.radius);
  let signedY = i32(brush.centerY) + i32(localY) - i32(brush.radius);
  if (signedX < 0 || signedY < 0 || signedX >= i32(brush.width) || signedY >= i32(brush.height)) {
    return;
  }
  let deltaX = i32(localX) - i32(brush.radius);
  let deltaY = i32(localY) - i32(brush.radius);
  if (deltaX * deltaX + deltaY * deltaY > i32(brush.radius * brush.radius)) { return; }
  let index = u32(signedY) * brush.width + u32(signedX);
  let temperature = select(128u, 255u, brush.material == 5u);
  cells[index] = (brush.material & 0xffu) | (temperature << 8u);
}
`;

export const pixelRenderShader = /* wgsl */ `
struct RenderParams {
  width: u32,
  height: u32,
  padding0: u32,
  padding1: u32,
}

@group(0) @binding(0) var<storage, read> cells: array<u32>;
@group(0) @binding(1) var<uniform> params: RenderParams;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

fn color(material: u32) -> vec4<f32> {
  if (material == 1u) { return vec4<f32>(0.31, 0.35, 0.38, 1.0); }
  if (material == 2u) { return vec4<f32>(0.94, 0.69, 0.24, 1.0); }
  if (material == 3u) { return vec4<f32>(0.18, 0.55, 0.91, 1.0); }
  if (material == 4u) { return vec4<f32>(0.80, 0.54, 0.85, 1.0); }
  if (material == 5u) { return vec4<f32>(1.00, 0.29, 0.16, 1.0); }
  return vec4<f32>(0.045, 0.063, 0.082, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let x = min(u32(position.x), params.width - 1u);
  let y = min(u32(position.y), params.height - 1u);
  return color(cells[y * params.width + x] & 0xffu);
}
`;
