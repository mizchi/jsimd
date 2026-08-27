import { reduceTopKShader, squaredL2TopKShader } from "./kernels.wgsl.ts";

const WORKGROUP_SIZE = 256;
const MAX_SUPPORTED_K = 32;
const CANDIDATE_BYTES = 8;
const PARAMETER_BYTES = 32;

export interface WebGpuVectorSearchOptions {
  readonly adapter?: GPUAdapter;
  readonly maxK?: number;
  readonly maxBatchSize?: number;
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
    distancePipeline: GPUComputePipeline,
    reducePipeline: GPUComputePipeline,
  ) {
    this.#device = device;
    this.adapterInfo = adapterInfo;
    this.maxK = maxK;
    this.maxBatchSize = maxBatchSize;
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

export class WebGpuVectorIndex implements Disposable {
  readonly rows: number;
  readonly dimensions: number;
  readonly maxK: number;
  readonly maxBatchSize: number;
  readonly residentBytes: number;
  readonly #device: GPUDevice;
  readonly #distancePipeline: GPUComputePipeline;
  readonly #reducePipeline: GPUComputePipeline;
  readonly #vectorBuffer: GPUBuffer;
  readonly #queryBuffer: GPUBuffer;
  readonly #parameterBuffer: GPUBuffer;
  readonly #candidateA: GPUBuffer;
  readonly #candidateB: GPUBuffer;
  readonly #readbackBuffer: GPUBuffer;
  readonly #distanceBindGroup: GPUBindGroup;
  readonly #reduceAToB: GPUBindGroup;
  readonly #reduceBToA: GPUBindGroup;
  #busy = false;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    distancePipeline: GPUComputePipeline,
    reducePipeline: GPUComputePipeline,
    vectorBuffer: GPUBuffer,
    queryBuffer: GPUBuffer,
    parameterBuffer: GPUBuffer,
    candidateA: GPUBuffer,
    candidateB: GPUBuffer,
    readbackBuffer: GPUBuffer,
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
    this.#queryBuffer = queryBuffer;
    this.#parameterBuffer = parameterBuffer;
    this.#candidateA = candidateA;
    this.#candidateB = candidateB;
    this.#readbackBuffer = readbackBuffer;
    this.rows = rows;
    this.dimensions = dimensions;
    this.maxK = maxK;
    this.maxBatchSize = maxBatchSize;
    this.residentBytes = residentBytes;
    this.#distanceBindGroup = device.createBindGroup({
      layout: distancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: vectorBuffer } },
        { binding: 1, resource: { buffer: queryBuffer } },
        { binding: 2, resource: { buffer: parameterBuffer } },
        { binding: 3, resource: { buffer: candidateA } },
      ],
    });
    this.#reduceAToB = createReduceBindGroup(
      device,
      reducePipeline,
      candidateA,
      parameterBuffer,
      candidateB,
    );
    this.#reduceBToA = createReduceBindGroup(
      device,
      reducePipeline,
      candidateB,
      parameterBuffer,
      candidateA,
    );
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
      const queryBuffer = makeBuffer(
        device,
        "query vector",
        dimensions * maxBatchSize * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const parameterBuffer = makeBuffer(
        device,
        "top-k parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const candidateUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
      const candidateA = makeBuffer(
        device,
        "top-k candidates A",
        candidateBytes,
        candidateUsage,
        buffers,
      );
      const candidateB = makeBuffer(
        device,
        "top-k candidates B",
        candidateBytes,
        candidateUsage,
        buffers,
      );
      const readbackBuffer = makeBuffer(
        device,
        "top-k readback",
        maxK * maxBatchSize * CANDIDATE_BYTES,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        buffers,
      );
      const dimensionMajor = toDimensionMajor(values, rows, dimensions);
      device.queue.writeBuffer(vectorBuffer, 0, dimensionMajor);
      const residentBytes = values.byteLength + dimensions * maxBatchSize * 4 + PARAMETER_BYTES +
        candidateBytes * 2 + maxK * maxBatchSize * CANDIDATE_BYTES;
      return new WebGpuVectorIndex(
        device,
        distancePipeline,
        reducePipeline,
        vectorBuffer,
        queryBuffer,
        parameterBuffer,
        candidateA,
        candidateB,
        readbackBuffer,
        rows,
        dimensions,
        maxK,
        maxBatchSize,
        residentBytes,
      );
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }

  async topK(query: Float32Array, k: number): Promise<WebGpuTopKResult> {
    return await this.#withExclusiveQuery(query, 1, k, async () => {
      const finalBuffer = this.#dispatch(query, 1, k);
      return await this.#readback(finalBuffer, 1, k);
    });
  }

  async topKBatch(
    queries: Float32Array,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    return await this.#withExclusiveQuery(queries, queryCount, k, async () => {
      const finalBuffer = this.#dispatch(queries, queryCount, k);
      return await this.#readback(finalBuffer, queryCount, k);
    });
  }

  async profileTopK(query: Float32Array, k: number): Promise<WebGpuTopKProfile> {
    return await this.#withExclusiveQuery(query, 1, k, async () => {
      const totalStart = performance.now();
      const dispatchStart = performance.now();
      const finalBuffer = this.#dispatch(query, 1, k);
      await this.#device.queue.onSubmittedWorkDone();
      const dispatchMs = performance.now() - dispatchStart;
      const readbackStart = performance.now();
      const result = await this.#readback(finalBuffer, 1, k);
      const readbackMs = performance.now() - readbackStart;
      return { ...result, dispatchMs, readbackMs, totalMs: performance.now() - totalStart };
    });
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose WebGpuVectorIndex during a query");
    this.#disposed = true;
    this.#vectorBuffer.destroy();
    this.#queryBuffer.destroy();
    this.#parameterBuffer.destroy();
    this.#candidateA.destroy();
    this.#candidateB.destroy();
    this.#readbackBuffer.destroy();
  }

  #dispatch(query: Float32Array, queryCount: number, k: number): GPUBuffer {
    const queue = this.#device.queue;
    queue.writeBuffer(this.#queryBuffer, 0, gpuFloat32Source(query));
    let groupCount = Math.ceil(this.rows / WORKGROUP_SIZE);
    queue.writeBuffer(
      this.#parameterBuffer,
      0,
      parameters(this.rows, this.dimensions, this.rows, k, queryCount),
    );
    submitCompute(
      this.#device,
      this.#distancePipeline,
      this.#distanceBindGroup,
      groupCount,
      queryCount,
      0,
    );

    let inputCount = groupCount * k;
    let finalBuffer = this.#candidateA;
    while (groupCount > 1) {
      groupCount = Math.ceil(inputCount / WORKGROUP_SIZE);
      queue.writeBuffer(
        this.#parameterBuffer,
        0,
        parameters(this.rows, this.dimensions, inputCount, k, queryCount),
      );
      const inputIsA = finalBuffer === this.#candidateA;
      submitCompute(
        this.#device,
        this.#reducePipeline,
        inputIsA ? this.#reduceAToB : this.#reduceBToA,
        groupCount,
        queryCount,
        0,
      );
      finalBuffer = inputIsA ? this.#candidateB : this.#candidateA;
      inputCount = groupCount * k;
    }
    return finalBuffer;
  }

  async #readback(
    finalBuffer: GPUBuffer,
    queryCount: number,
    k: number,
  ): Promise<WebGpuTopKResult> {
    const resultCount = queryCount * k;
    const bytes = resultCount * CANDIDATE_BYTES;
    const encoder = this.#device.createCommandEncoder({ label: "top-k result readback" });
    encoder.copyBufferToBuffer(finalBuffer, 0, this.#readbackBuffer, 0, bytes);
    this.#device.queue.submit([encoder.finish()]);
    await this.#readbackBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
    try {
      const mapped = this.#readbackBuffer.getMappedRange(0, bytes);
      const view = new DataView(mapped);
      const ids = new Uint32Array(resultCount);
      const distances = new Float32Array(resultCount);
      for (let rank = 0; rank < resultCount; rank++) {
        distances[rank] = view.getFloat32(rank * CANDIDATE_BYTES, true);
        ids[rank] = view.getUint32(rank * CANDIDATE_BYTES + 4, true);
      }
      return { ids, distances };
    } finally {
      this.#readbackBuffer.unmap();
    }
  }

  async #withExclusiveQuery<T>(
    query: Float32Array,
    queryCount: number,
    k: number,
    operation: () => Promise<T>,
  ): Promise<T> {
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
    if (this.#busy) {
      throw new Error("concurrent queries require separate WebGpuVectorIndex instances");
    }
    this.#busy = true;
    this.#device.pushErrorScope("validation");
    let scopePopped = false;
    try {
      const result = await operation();
      const validationError = await this.#device.popErrorScope();
      scopePopped = true;
      if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
      return result;
    } catch (error) {
      if (!scopePopped) await this.#device.popErrorScope().catch(() => undefined);
      throw error;
    } finally {
      this.#busy = false;
    }
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
