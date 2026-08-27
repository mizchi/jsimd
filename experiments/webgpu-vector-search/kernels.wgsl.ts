// WGSL is kept in a TypeScript module so the same source can be imported by
// Deno and Vite without a runtime-specific raw-text loader.
const common = /* wgsl */ `
struct Params {
  rows: u32,
  dimensions: u32,
  inputCount: u32,
  k: u32,
  queryCount: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
}

struct Candidate {
  distance: f32,
  id: u32,
}

const WORKGROUP_SIZE: u32 = 256u;
const INFINITY: f32 = 3.402823e38;
const INVALID_ID: u32 = 0xffffffffu;

fn isBetter(distance: f32, id: u32, bestDistance: f32, bestId: u32) -> bool {
  return distance < bestDistance || (distance == bestDistance && id < bestId);
}
`;

export const squaredL2TopKShader = /* wgsl */ `${common}
@group(0) @binding(0) var<storage, read> vectors: array<f32>;
@group(0) @binding(1) var<storage, read> query: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> output: array<Candidate>;

var<workgroup> localDistances: array<f32, 256>;
var<workgroup> localIds: array<u32, 256>;

@compute @workgroup_size(256)
fn squaredL2TopK(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
) {
  let row = globalId.x;
  let lane = localId.x;
  let queryIndex = workgroupId.y;
  var distance = INFINITY;
  var id = INVALID_ID;
  if (row < params.rows) {
    distance = 0.0;
    id = row;
    for (var dimension = 0u; dimension < params.dimensions; dimension++) {
      let delta = vectors[dimension * params.rows + row] -
        query[queryIndex * params.dimensions + dimension];
      distance += delta * delta;
    }
  }
  localDistances[lane] = distance;
  localIds[lane] = id;
  workgroupBarrier();

  if (lane == 0u) {
    for (var rank = 0u; rank < params.k; rank++) {
      var bestDistance = INFINITY;
      var bestId = INVALID_ID;
      var bestLane = INVALID_ID;
      for (var candidate = 0u; candidate < WORKGROUP_SIZE; candidate++) {
        let candidateDistance = localDistances[candidate];
        let candidateId = localIds[candidate];
        if (isBetter(candidateDistance, candidateId, bestDistance, bestId)) {
          bestDistance = candidateDistance;
          bestId = candidateId;
          bestLane = candidate;
        }
      }
      let groupCount = (params.rows + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
      let outputIndex = (queryIndex * groupCount + workgroupId.x) * params.k + rank;
      output[outputIndex] = Candidate(bestDistance, bestId);
      if (bestLane != INVALID_ID) {
        localDistances[bestLane] = INFINITY;
        localIds[bestLane] = INVALID_ID;
      }
    }
  }
}
`;

export const reduceTopKShader = /* wgsl */ `${common}
@group(0) @binding(0) var<storage, read> input: array<Candidate>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> output: array<Candidate>;

var<workgroup> localDistances: array<f32, 256>;
var<workgroup> localIds: array<u32, 256>;

@compute @workgroup_size(256)
fn reduceTopK(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
) {
  let index = globalId.x;
  let lane = localId.x;
  let queryIndex = workgroupId.y;
  if (index < params.inputCount) {
    let item = input[queryIndex * params.inputCount + index];
    localDistances[lane] = item.distance;
    localIds[lane] = item.id;
  } else {
    localDistances[lane] = INFINITY;
    localIds[lane] = INVALID_ID;
  }
  workgroupBarrier();

  if (lane == 0u) {
    for (var rank = 0u; rank < params.k; rank++) {
      var bestDistance = INFINITY;
      var bestId = INVALID_ID;
      var bestLane = INVALID_ID;
      for (var candidate = 0u; candidate < WORKGROUP_SIZE; candidate++) {
        let candidateDistance = localDistances[candidate];
        let candidateId = localIds[candidate];
        if (isBetter(candidateDistance, candidateId, bestDistance, bestId)) {
          bestDistance = candidateDistance;
          bestId = candidateId;
          bestLane = candidate;
        }
      }
      let groupCount = (params.inputCount + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
      let outputIndex = (queryIndex * groupCount + workgroupId.x) * params.k + rank;
      output[outputIndex] = Candidate(bestDistance, bestId);
      if (bestLane != INVALID_ID) {
        localDistances[bestLane] = INFINITY;
        localIds[bestLane] = INVALID_ID;
      }
    }
  }
}
`;
