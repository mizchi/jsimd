import { reduceTopKShader, squaredL2TopKShader } from "./kernels.wgsl.ts";

const WORKGROUP_SIZE = 256;
const MAX_SUPPORTED_K = 32;
const CANDIDATE_BYTES = 8;
const PARAMETER_BYTES = 32;

export interface WebGpuVectorSearchOptions {
  readonly adapter?: GPUAdapter;
  readonly maxK?: number;
  readonly maxBatchSize?: number;
  /** Independent query/scratch/readback slots available to concurrent submissions. */
  readonly inFlightSlots?: number;
}

export interface WebGpuTopKResult {
  readonly ids: Uint32Array;
  readonly distances: Float32Array;
}

export interface WebGpuTopKProfile extends WebGpuTopKResult {
  /** Query upload, all compute submissions, and explicit GPU synchronization. */
  readonly dispatchMs: number;
  /** Final k-candidate GPU copy, mapAsync, and CPU copy. */
  readonly readbackMs: number;
  readonly totalMs: number;
}

/** Owns the device and reusable pipelines; uploaded indexes own their buffers. */
export class WebGpuVectorSearch implements AsyncDisposable {
  readonly maxK: number;
  readonly maxBatchSize: number;
  readonly inFlightSlots: number;
  readonly adapterInfo: GPUAdapterInfo;
  readonly #device: GPUDevice;
  readonly #distancePipeline: GPUComputePipeline;
  readonly #reducePipeline: GPUComputePipeline;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    adapterInfo: GPUAdapterInfo,
    maxK: number,
    maxBatchSize: number,
    inFlightSlots: number,
    distancePipeline: GPUComputePipeline,
    reducePipeline: GPUComputePipeline,
  ) {
    this.#device = device;
    this.adapterInfo = adapterInfo;
    this.maxK = maxK;
    this.maxBatchSize = maxBatchSize;
    this.inFlightSlots = inFlightSlots;
    this.#distancePipeline = distancePipeline;
    this.#reducePipeline = reducePipeline;
  }

  static async create(options: WebGpuVectorSearchOptions = {}): Promise<WebGpuVectorSearch> {
    const maxK = options.maxK ?? 10;
    if (!Number.isSafeInteger(maxK) || maxK < 1 || maxK > MAX_SUPPORTED_K) {
      throw new RangeError(`maxK must be an integer in [1, ${MAX_SUPPORTED_K}]`);
    }
    const maxBatchSize = options.maxBatchSize ?? 64;
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new RangeError("maxBatchSize must be a positive integer");
    }
    const inFlightSlots = options.inFlightSlots ?? 1;
    if (!Number.isSafeInteger(inFlightSlots) || inFlightSlots < 1) {
      throw new RangeError("inFlightSlots must be a positive integer");
    }
    const adapter = options.adapter ?? await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter is unavailable");
    const device = await adapter.requestDevice();
    try {
      if (maxBatchSize > device.limits.maxComputeWorkgroupsPerDimension) {
        throw new RangeError("maxBatchSize exceeds the WebGPU dispatch limit");
      }
      const distanceModule = device.createShaderModule({
        label: "jsimd experimental squared-L2 top-k",
        code: squaredL2TopKShader,
      });
      const reduceModule = device.createShaderModule({
        label: "jsimd experimental top-k reduction",
        code: reduceTopKShader,
      });
      const compilations = await Promise.all([
        distanceModule.getCompilationInfo(),
        reduceModule.getCompilationInfo(),
      ]);
      const errors = compilations.flatMap((compilation) =>
        compilation.messages.filter((message) => message.type === "error")
      );
      if (errors.length > 0) {
        throw new Error(errors.map((message) => message.message).join("\n"));
      }
      const distancePipeline = device.createComputePipeline({
        label: "squared-L2 workgroup top-k",
        layout: "auto",
        compute: { module: distanceModule, entryPoint: "squaredL2TopK" },
      });
      const reducePipeline = device.createComputePipeline({
        label: "candidate top-k reduction",
        layout: "auto",
        compute: { module: reduceModule, entryPoint: "reduceTopK" },
      });
      return new WebGpuVectorSearch(
        device,
        adapter.info,
        maxK,
        maxBatchSize,
        inFlightSlots,
        distancePipeline,
        reducePipeline,
      );
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  upload(values: Float32Array, rows: number, dimensions: number): WebGpuVectorIndex {
    this.#assertAlive();
    validateShape(values, rows, dimensions);
    const vectorBytes = values.byteLength;
    const firstGroupCount = Math.ceil(rows / WORKGROUP_SIZE);
    const candidateBytes = firstGroupCount * this.maxK * this.maxBatchSize * CANDIDATE_BYTES;
    const limits = this.#device.limits;
    if (vectorBytes > limits.maxStorageBufferBindingSize || vectorBytes > limits.maxBufferSize) {
      throw new RangeError("vectors exceed the WebGPU device storage-buffer limit");
    }
    if (
      candidateBytes > limits.maxStorageBufferBindingSize || candidateBytes > limits.maxBufferSize
    ) {
      throw new RangeError("top-k scratch exceeds the WebGPU device storage-buffer limit");
    }
    const queryBytes = dimensions * this.maxBatchSize * Float32Array.BYTES_PER_ELEMENT;
    if (queryBytes > limits.maxStorageBufferBindingSize || queryBytes > limits.maxBufferSize) {
      throw new RangeError("query batch exceeds the WebGPU device storage-buffer limit");
    }
    if (firstGroupCount > limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("row count exceeds the WebGPU dispatch limit");
    }
    return WebGpuVectorIndex.create(
      this.#device,
      this.#distancePipeline,
      this.#reducePipeline,
      values,
      rows,
      dimensions,
      this.maxK,
      this.maxBatchSize,
      this.inFlightSlots,
      candidateBytes,
    );
  }

  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#device.destroy();
    return Promise.resolve();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGpuVectorSearch is disposed");
  }
}

interface WebGpuQuerySlot {
  readonly queryBuffer: GPUBuffer;
  readonly parameterBuffers: readonly GPUBuffer[];
  readonly candidateA: GPUBuffer;
  readonly candidateB: GPUBuffer;
  readonly readbackBuffer: GPUBuffer;
  readonly distanceBindGroup: GPUBindGroup;
  readonly reduceAToB: readonly GPUBindGroup[];
  readonly reduceBToA: readonly GPUBindGroup[];
  busy: boolean;
}

export class WebGpuVectorIndex implements Disposable {
  readonly rows: number;
  readonly dimensions: number;
  readonly maxK: number;
  readonly maxBatchSize: number;
  readonly inFlightSlots: number;
  readonly residentBytes: number;
  readonly #device: GPUDevice;
  readonly #distancePipeline: GPUComputePipeline;
  readonly #reducePipeline: GPUComputePipeline;
  readonly #vectorBuffer: GPUBuffer;
  readonly #slots: readonly WebGpuQuerySlot[];
  #nextSlot = 0;
  #activeQueries = 0;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    distancePipeline: GPUComputePipeline,
    reducePipeline: GPUComputePipeline,
    vectorBuffer: GPUBuffer,
    slots: readonly WebGpuQuerySlot[],
    rows: number,
    dimensions: number,
    maxK: number,
    maxBatchSize: number,
    residentBytes: number,
  ) {
    this.#device = device;
    this.#distancePipeline = distancePipeline;
    this.#reducePipeline = reducePipeline;
    this.#vectorBuffer = vectorBuffer;
    this.#slots = slots;
    this.rows = rows;
    this.dimensions = dimensions;
    this.maxK = maxK;
    this.maxBatchSize = maxBatchSize;
    this.inFlightSlots = slots.length;
    this.residentBytes = residentBytes;
  }

  static create(
    device: GPUDevice,
    distancePipeline: GPUComputePipeline,
    reducePipeline: GPUComputePipeline,
    values: Float32Array,
    rows: number,
    dimensions: number,
    maxK: number,
    maxBatchSize: number,
    inFlightSlots: number,
    candidateBytes: number,
  ): WebGpuVectorIndex {
    const buffers: GPUBuffer[] = [];
    try {
      const vectorBuffer = makeBuffer(
        device,
        "resident dimension-major vectors",
        values.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const slots = Array.from({ length: inFlightSlots }, (_, index) =>
        createQuerySlot(
          device,
          distancePipeline,
          reducePipeline,
          vectorBuffer,
          rows,
          dimensions,
          maxK,
          maxBatchSize,
          candidateBytes,
          index,
          buffers,
        ));
      const dimensionMajor = toDimensionMajor(values, rows, dimensions);
      device.queue.writeBuffer(vectorBuffer, 0, dimensionMajor);
      const bytesPerSlot = dimensions * maxBatchSize * 4 +
        PARAMETER_BYTES * maximumPassCount(rows, maxK) + candidateBytes * 2 +
        maxK * maxBatchSize * CANDIDATE_BYTES;
      return new WebGpuVectorIndex(
        device,
        distancePipeline,
        reducePipeline,
        vectorBuffer,
        slots,
        rows,
        dimensions,
        maxK,
        maxBatchSize,
        values.byteLength + bytesPerSlot * inFlightSlots,
      );
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }

  async topK(query: Float32Array, k: number): Promise<WebGpuTopKResult> {
    return await this.#withQuerySlot(query, 1, k, async (slot) => {
      const finalBuffer = this.#dispatch(slot, query, 1, k);
      return await this.#readback(slot, finalBuffer, 1, k);
    });
  }

  async topKBatch(
    queries: Float32Array,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    return await this.#withQuerySlot(queries, queryCount, k, async (slot) => {
      const finalBuffer = this.#dispatch(slot, queries, queryCount, k);
      return await this.#readback(slot, finalBuffer, queryCount, k);
    });
  }

  async topKBatchSingleSubmission(
    queries: Float32Array,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    return await this.#withQuerySlot(queries, queryCount, k, async (slot) => {
      return await this.#submitSingleCommand(slot, queries, queryCount, k);
    });
  }

  async profileTopK(query: Float32Array, k: number): Promise<WebGpuTopKProfile> {
    return await this.#withQuerySlot(query, 1, k, async (slot) => {
      const totalStart = performance.now();
      const dispatchStart = performance.now();
      const finalBuffer = this.#dispatch(slot, query, 1, k);
      await this.#device.queue.onSubmittedWorkDone();
      const dispatchMs = performance.now() - dispatchStart;
      const readbackStart = performance.now();
      const result = await this.#readback(slot, finalBuffer, 1, k);
      const readbackMs = performance.now() - readbackStart;
      return { ...result, dispatchMs, readbackMs, totalMs: performance.now() - totalStart };
    });
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    if (this.#activeQueries !== 0) {
      throw new Error("cannot dispose WebGpuVectorIndex during a query");
    }
    this.#disposed = true;
    this.#vectorBuffer.destroy();
    for (const slot of this.#slots) {
      slot.queryBuffer.destroy();
      for (const buffer of slot.parameterBuffers) buffer.destroy();
      slot.candidateA.destroy();
      slot.candidateB.destroy();
      slot.readbackBuffer.destroy();
    }
  }

  #dispatch(
    slot: WebGpuQuerySlot,
    query: Float32Array,
    queryCount: number,
    k: number,
  ): GPUBuffer {
    const queue = this.#device.queue;
    queue.writeBuffer(slot.queryBuffer, 0, gpuFloat32Source(query));
    let groupCount = Math.ceil(this.rows / WORKGROUP_SIZE);
    queue.writeBuffer(
      slot.parameterBuffers[0]!,
      0,
      parameters(this.rows, this.dimensions, this.rows, k, queryCount),
    );
    submitCompute(
      this.#device,
      this.#distancePipeline,
      slot.distanceBindGroup,
      groupCount,
      queryCount,
      0,
    );

    let inputCount = groupCount * k;
    let finalBuffer = slot.candidateA;
    let passIndex = 1;
    while (groupCount > 1) {
      groupCount = Math.ceil(inputCount / WORKGROUP_SIZE);
      queue.writeBuffer(
        slot.parameterBuffers[passIndex]!,
        0,
        parameters(this.rows, this.dimensions, inputCount, k, queryCount),
      );
      const inputIsA = finalBuffer === slot.candidateA;
      submitCompute(
        this.#device,
        this.#reducePipeline,
        inputIsA ? slot.reduceAToB[passIndex - 1]! : slot.reduceBToA[passIndex - 1]!,
        groupCount,
        queryCount,
        0,
      );
      finalBuffer = inputIsA ? slot.candidateB : slot.candidateA;
      inputCount = groupCount * k;
      passIndex++;
    }
    return finalBuffer;
  }

  async #submitSingleCommand(
    slot: WebGpuQuerySlot,
    query: Float32Array,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    const queue = this.#device.queue;
    queue.writeBuffer(slot.queryBuffer, 0, gpuFloat32Source(query));
    const encoder = this.#device.createCommandEncoder({ label: "single-submission exact top-k" });
    let groupCount = Math.ceil(this.rows / WORKGROUP_SIZE);
    queue.writeBuffer(
      slot.parameterBuffers[0]!,
      0,
      parameters(this.rows, this.dimensions, this.rows, k, queryCount),
    );
    encodeCompute(
      encoder,
      this.#distancePipeline,
      slot.distanceBindGroup,
      groupCount,
      queryCount,
      0,
    );
    let inputCount = groupCount * k;
    let finalBuffer = slot.candidateA;
    let passIndex = 1;
    while (groupCount > 1) {
      groupCount = Math.ceil(inputCount / WORKGROUP_SIZE);
      queue.writeBuffer(
        slot.parameterBuffers[passIndex]!,
        0,
        parameters(this.rows, this.dimensions, inputCount, k, queryCount),
      );
      const inputIsA = finalBuffer === slot.candidateA;
      encodeCompute(
        encoder,
        this.#reducePipeline,
        inputIsA ? slot.reduceAToB[passIndex - 1]! : slot.reduceBToA[passIndex - 1]!,
        groupCount,
        queryCount,
        0,
      );
      finalBuffer = inputIsA ? slot.candidateB : slot.candidateA;
      inputCount = groupCount * k;
      passIndex++;
    }
    const resultCount = queryCount * k;
    const bytes = resultCount * CANDIDATE_BYTES;
    encoder.copyBufferToBuffer(finalBuffer, 0, slot.readbackBuffer, 0, bytes);
    queue.submit([encoder.finish()]);
    return await this.#mapReadback(slot, resultCount, bytes);
  }

  async #readback(
    slot: WebGpuQuerySlot,
    finalBuffer: GPUBuffer,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    const resultCount = queryCount * k;
    const bytes = resultCount * CANDIDATE_BYTES;
    const encoder = this.#device.createCommandEncoder({ label: "top-k result readback" });
    encoder.copyBufferToBuffer(finalBuffer, 0, slot.readbackBuffer, 0, bytes);
    this.#device.queue.submit([encoder.finish()]);
    return await this.#mapReadback(slot, resultCount, bytes);
  }

  async #mapReadback(
    slot: WebGpuQuerySlot,
    resultCount: number,
    bytes: number,
  ): Promise<WebGpuTopKResult> {
    await slot.readbackBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
    try {
      const mapped = slot.readbackBuffer.getMappedRange(0, bytes);
      const view = new DataView(mapped);
      const ids = new Uint32Array(resultCount);
      const distances = new Float32Array(resultCount);
      for (let rank = 0; rank < resultCount; rank++) {
        distances[rank] = view.getFloat32(rank * CANDIDATE_BYTES, true);
        ids[rank] = view.getUint32(rank * CANDIDATE_BYTES + 4, true);
      }
      return { ids, distances };
    } finally {
      slot.readbackBuffer.unmap();
    }
  }

  async #withQuerySlot<T>(
    query: Float32Array,
    queryCount: number,
    k: number,
    operation: (slot: WebGpuQuerySlot) => Promise<T>,
  ): Promise<T> {
    this.#validateQuery(query, queryCount, k);
    const slot = this.#acquireSlot();
    this.#device.pushErrorScope("validation");
    let operationPromise: Promise<T>;
    let validationPromise: Promise<GPUError | null>;
    try {
      operationPromise = operation(slot);
      validationPromise = this.#device.popErrorScope();
    } catch (error) {
      await this.#device.popErrorScope().catch(() => undefined);
      this.#releaseSlot(slot);
      throw error;
    }
    try {
      const [result, validationError] = await Promise.all([operationPromise, validationPromise]);
      if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
      return result;
    } finally {
      this.#releaseSlot(slot);
    }
  }

  #validateQuery(query: Float32Array, queryCount: number, k: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > this.maxBatchSize) {
      throw new RangeError("queryCount must be covered by maxBatchSize");
    }
    if (!(query instanceof Float32Array) || query.length !== this.dimensions * queryCount) {
      throw new RangeError("query dimensions must match the index");
    }
    if (!Number.isSafeInteger(k) || k < 1 || k > this.maxK || k > this.rows) {
      throw new RangeError("k must be a positive integer covered by maxK and row count");
    }
  }

  #acquireSlot(): WebGpuQuerySlot {
    for (let offset = 0; offset < this.#slots.length; offset++) {
      const index = (this.#nextSlot + offset) % this.#slots.length;
      const slot = this.#slots[index]!;
      if (slot.busy) continue;
      slot.busy = true;
      this.#activeQueries++;
      this.#nextSlot = (index + 1) % this.#slots.length;
      return slot;
    }
    throw new Error(`all ${this.inFlightSlots} WebGPU in-flight slots are busy`);
  }

  #releaseSlot(slot: WebGpuQuerySlot): void {
    slot.busy = false;
    this.#activeQueries--;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGpuVectorIndex is disposed");
  }
}

function makeBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: GPUBufferUsageFlags,
  buffers: GPUBuffer[],
): GPUBuffer {
  const buffer = device.createBuffer({ label, size, usage });
  buffers.push(buffer);
  return buffer;
}

function createQuerySlot(
  device: GPUDevice,
  distancePipeline: GPUComputePipeline,
  reducePipeline: GPUComputePipeline,
  vectorBuffer: GPUBuffer,
  rows: number,
  dimensions: number,
  maxK: number,
  maxBatchSize: number,
  candidateBytes: number,
  slotIndex: number,
  buffers: GPUBuffer[],
): WebGpuQuerySlot {
  const queryBuffer = makeBuffer(
    device,
    `query batch slot ${slotIndex}`,
    dimensions * maxBatchSize * Float32Array.BYTES_PER_ELEMENT,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    buffers,
  );
  const parameterBuffers = Array.from(
    { length: maximumPassCount(rows, maxK) },
    (_, passIndex) =>
      makeBuffer(
        device,
        `top-k parameters slot ${slotIndex} pass ${passIndex}`,
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      ),
  );
  const candidateUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
  const candidateA = makeBuffer(
    device,
    `top-k candidates A slot ${slotIndex}`,
    candidateBytes,
    candidateUsage,
    buffers,
  );
  const candidateB = makeBuffer(
    device,
    `top-k candidates B slot ${slotIndex}`,
    candidateBytes,
    candidateUsage,
    buffers,
  );
  const readbackBuffer = makeBuffer(
    device,
    `top-k readback slot ${slotIndex}`,
    maxK * maxBatchSize * CANDIDATE_BYTES,
    GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    buffers,
  );
  return {
    queryBuffer,
    parameterBuffers,
    candidateA,
    candidateB,
    readbackBuffer,
    distanceBindGroup: device.createBindGroup({
      layout: distancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: vectorBuffer } },
        { binding: 1, resource: { buffer: queryBuffer } },
        { binding: 2, resource: { buffer: parameterBuffers[0]! } },
        { binding: 3, resource: { buffer: candidateA } },
      ],
    }),
    reduceAToB: parameterBuffers.slice(1).map((parameterBuffer) =>
      createReduceBindGroup(device, reducePipeline, candidateA, parameterBuffer, candidateB)
    ),
    reduceBToA: parameterBuffers.slice(1).map((parameterBuffer) =>
      createReduceBindGroup(device, reducePipeline, candidateB, parameterBuffer, candidateA)
    ),
    busy: false,
  };
}

function createReduceBindGroup(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  input: GPUBuffer,
  parameters: GPUBuffer,
  output: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: input } },
      { binding: 1, resource: { buffer: parameters } },
      { binding: 2, resource: { buffer: output } },
    ],
  });
}

function submitCompute(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  workgroupsX: number,
  workgroupsY: number,
  groupIndex: number,
): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(groupIndex, bindGroup);
  pass.dispatchWorkgroups(workgroupsX, workgroupsY);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function encodeCompute(
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  workgroupsX: number,
  workgroupsY: number,
  groupIndex: number,
): void {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(groupIndex, bindGroup);
  pass.dispatchWorkgroups(workgroupsX, workgroupsY);
  pass.end();
}

function maximumPassCount(rows: number, maxK: number): number {
  let groupCount = Math.ceil(rows / WORKGROUP_SIZE);
  let inputCount = groupCount * maxK;
  let passes = 1;
  while (groupCount > 1) {
    groupCount = Math.ceil(inputCount / WORKGROUP_SIZE);
    inputCount = groupCount * maxK;
    passes++;
  }
  return passes;
}

function validateShape(values: Float32Array, rows: number, dimensions: number): void {
  if (!(values instanceof Float32Array)) throw new TypeError("values must be a Float32Array");
  if (!Number.isSafeInteger(rows) || rows < 1) throw new RangeError("rows must be positive");
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new RangeError("dimensions must be positive");
  }
  if (values.length !== rows * dimensions) throw new RangeError("values do not match the shape");
}

function gpuFloat32Source(values: Float32Array): Float32Array<ArrayBuffer> {
  return values.buffer instanceof ArrayBuffer
    ? values as Float32Array<ArrayBuffer>
    : new Float32Array(values);
}

function parameters(
  rows: number,
  dimensions: number,
  inputCount: number,
  k: number,
  queryCount: number,
): Uint32Array<ArrayBuffer> {
  return new Uint32Array([rows, dimensions, inputCount, k, queryCount, 0, 0, 0]);
}

function toDimensionMajor(
  values: Float32Array,
  rows: number,
  dimensions: number,
): Float32Array<ArrayBuffer> {
  const output = new Float32Array(values.length);
  for (let row = 0; row < rows; row++) {
    const inputOffset = row * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      output[dimension * rows + row] = values[inputOffset + dimension]!;
    }
  }
  return output;
}
