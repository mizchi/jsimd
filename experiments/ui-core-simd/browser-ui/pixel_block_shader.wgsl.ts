export const pixelBlockComputeShader = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  tick: u32,
  seed: u32,
  blockColumns: u32,
  blockCount: u32,
  padding0: u32,
  padding1: u32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;

fn material(cell: u32) -> u32 { return cell & 0xffu; }

fn density(value: u32) -> i32 {
  if (value == 2u) { return 2; }
  if (value == 3u) { return 1; }
  if (value == 4u) { return -1; }
  return 0;
}

fn shouldFall(top: u32, bottom: u32) -> bool {
  let topMaterial = material(top);
  let bottomMaterial = material(bottom);
  return topMaterial != 1u && bottomMaterial != 1u &&
    density(topMaterial) > density(bottomMaterial);
}

fn isFluid(value: u32) -> bool { return value == 3u || value == 4u; }

fn shouldFlowRight(left: u32, right: u32) -> bool {
  return isFluid(material(left)) && material(right) == 0u;
}

fn shouldFlowLeft(left: u32, right: u32) -> bool {
  return material(left) == 0u && isFluid(material(right));
}

fn blockRandom(seed: u32, tick: u32, blockX: u32, blockY: u32) -> u32 {
  let coordinate = blockY * 0x10001u + blockX + 1u;
  var value = seed ^ ((tick + 1u) * 0x9e3779b9u) ^ (coordinate * 0x85ebca6bu);
  value = value ^ (value << 13u);
  value = value ^ (value >> 17u);
  return value ^ (value << 5u);
}

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.blockCount) { return; }
  let origin = params.tick & 1u;
  let blockX = id.x % params.blockColumns;
  let blockY = id.x / params.blockColumns;
  let x = origin + blockX * 2u;
  let y = origin + blockY * 2u;
  let topLeft = y * params.width + x;
  let topRight = topLeft + 1u;
  let bottomLeft = topLeft + params.width;
  let bottomRight = bottomLeft + 1u;
  var a = cells[topLeft];
  var b = cells[topRight];
  var c = cells[bottomLeft];
  var d = cells[bottomRight];
  var moved = 0u;

  if (shouldFall(a, c)) {
    let value = a; a = c; c = value; moved = moved | 0x5u;
  }
  if (shouldFall(b, d)) {
    let value = b; b = d; d = value; moved = moved | 0xau;
  }

  if (moved != 0xfu) {
    let random = blockRandom(params.seed, params.tick, blockX, blockY);
    if ((random & 0x3u) != 0u && (moved & 0x9u) == 0u && shouldFall(a, d)) {
      let value = a; a = d; d = value; moved = moved | 0x9u;
    }
    if (((random >> 2u) & 0x3u) != 0u && (moved & 0x6u) == 0u && shouldFall(b, c)) {
      let value = b; b = c; c = value; moved = moved | 0x6u;
    }
    if ((moved & 0x3u) == 0u) {
      let flows = select(shouldFlowRight(a, b), shouldFlowLeft(a, b), (random & 0x10u) != 0u);
      if (flows) { let value = a; a = b; b = value; moved = moved | 0x3u; }
    }
    if ((moved & 0xcu) == 0u) {
      let flows = select(shouldFlowRight(c, d), shouldFlowLeft(c, d), (random & 0x20u) != 0u);
      if (flows) { let value = c; c = d; d = value; moved = moved | 0xcu; }
    }
  }

  cells[topLeft] = a;
  cells[topRight] = b;
  cells[bottomLeft] = c;
  cells[bottomRight] = d;
}
`;
