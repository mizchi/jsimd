/** Optional semantic reaction pass; normal resident movement/rendering never imports it. */
export const pixelReactionEventComputeShader = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  eventCapacity: u32,
  tick: u32,
}

struct EventBuffer {
  count: atomic<u32>,
  dropped: atomic<u32>,
  tick: u32,
  padding: u32,
  records: array<vec4<u32>>,
}

@group(0) @binding(0) var<storage, read> inputCells: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputCells: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> eventBuffer: EventBuffer;

fn temperature(cell: u32) -> u32 { return (cell >> 8u) & 0xffu; }

fn neighborTemperature(index: u32, x: u32, y: u32) -> u32 {
  let left = select(index - 1u, index, x == 0u);
  let right = select(index + 1u, index, x + 1u == params.width);
  let top = select(index - params.width, index, y == 0u);
  let bottom = select(index + params.width, index, y + 1u == params.height);
  return (
    temperature(inputCells[index]) * 4u +
    temperature(inputCells[left]) +
    temperature(inputCells[right]) +
    temperature(inputCells[top]) +
    temperature(inputCells[bottom])
  ) >> 3u;
}

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let cellCount = params.width * params.height;
  if (index >= cellCount) { return; }
  let x = index % params.width;
  let y = index / params.width;
  let before = inputCells[index];
  let material = before & 0xffu;
  var nextTemperature = neighborTemperature(index, x, y);
  if (material == 5u) { nextTemperature = 255u; }
  var nextMaterial = material;
  var kind = 0u;
  if (material == 3u && nextTemperature >= 140u) {
    nextMaterial = 4u;
    kind = 1u;
  } else if (material == 4u && nextTemperature <= 112u) {
    nextMaterial = 3u;
    kind = 2u;
  }
  let after = (before & 0xffff0000u) | (nextTemperature << 8u) | nextMaterial;
  outputCells[index] = after;
  if (kind != 0u) {
    let slot = atomicAdd(&eventBuffer.count, 1u);
    if (slot < params.eventCapacity) {
      eventBuffer.records[slot] = vec4<u32>(kind, index, before, after);
    } else {
      atomicAdd(&eventBuffer.dropped, 1u);
    }
  }
}
`;
