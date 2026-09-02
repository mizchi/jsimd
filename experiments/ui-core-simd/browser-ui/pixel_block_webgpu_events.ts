import {
  decodePixelBlockGpuEvents,
  type PixelBlockGpuEventBatch,
  pixelBlockGpuEventBytes,
} from "../pixel_block_gpu_events.ts";
import {
  createPixelBlockGpuPlan,
  PIXEL_BLOCK_GPU_WORKGROUP_SIZE,
} from "../pixel_block_gpu_plan.ts";
import { DEFAULT_PIXEL_BLOCK_SEED } from "../pixel_block_sim.ts";
import { pixelBlockEventComputeShader } from "./pixel_block_event_shader.wgsl.ts";

const PARAMETER_BYTES = 32;

export interface PixelBlockGpuEventReadback extends PixelBlockGpuEventBatch {
  readonly readbackMs: number;
}

/** Explicit event-enabled compute backend; isolated from the zero-readback render path. */
export class WebGpuBlockEventSimulation implements AsyncDisposable {
  readonly residentBytes: number;
  readonly adapterInfo: GPUAdapterInfo;
  readonly #device: GPUDevice;
  readonly #state: GPUBuffer;
  readonly #params: GPUBuffer;
  readonly #events: GPUBuffer;
  readonly #eventReadback: GPUBuffer;
  readonly #pipeline: GPUComputePipeline;
  readonly #bindGroup: GPUBindGroup;
  readonly #buffers: readonly GPUBuffer[];
  readonly #width: number;
  readonly #height: number;
  readonly #capacity: number;
  readonly #seed: number;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    state: GPUBuffer,
    params: GPUBuffer,
    events: GPUBuffer,
    eventReadback: GPUBuffer,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    buffers: readonly GPUBuffer[],
    width: number,
    height: number,
    capacity: number,
    seed: number,
    adapterInfo: GPUAdapterInfo,
  ) {
    this.#device = device;
    this.#state = state;
    this.#params = params;
    this.#events = events;
    this.#eventReadback = eventReadback;
    this.#pipeline = pipeline;
    this.#bindGroup = bindGroup;
    this.#buffers = buffers;
    this.#width = width;
    this.#height = height;
    this.#capacity = capacity;
    this.#seed = seed;
    this.residentBytes = state.size + params.size + events.size;
    this.adapterInfo = adapterInfo;
  }

  static async create(
    initialCells: Uint32Array,
    width: number,
    height: number,
    capacity: number,
    seed = DEFAULT_PIXEL_BLOCK_SEED,
  ): Promise<WebGpuBlockEventSimulation> {
    if (initialCells.length !== width * height) throw new RangeError("initial cells do not match");
    const eventBytes = pixelBlockGpuEventBytes(capacity);
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter is unavailable");
    const device = await adapter.requestDevice();
    const buffers: GPUBuffer[] = [];
    try {
      const state = makeBuffer(
        device,
        "event pixel cells",
        initialCells.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      const params = makeBuffer(
        device,
        "event step parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const events = makeBuffer(
        device,
        "bounded changed-block events",
        eventBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      const eventReadback = makeBuffer(
        device,
        "changed-block event readback",
        eventBytes,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        buffers,
      );
      device.queue.writeBuffer(state, 0, initialCells.slice());
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const module = device.createShaderModule({ code: pixelBlockEventComputeShader });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter((message) => message.type === "error");
      if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("\n"));
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "step" },
      });
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: state } },
          { binding: 1, resource: { buffer: params } },
          { binding: 2, resource: { buffer: events } },
        ],
      });
      return new WebGpuBlockEventSimulation(
        device,
        state,
        params,
        events,
        eventReadback,
        pipeline,
        bindGroup,
        buffers,
        width,
        height,
        capacity,
        seed,
        adapter.info,
      );
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
      throw error;
    }
  }

  async stepAndReadEvents(tick: number): Promise<PixelBlockGpuEventReadback> {
    this.#assertAlive();
    const started = performance.now();
    const eventBytes = pixelBlockGpuEventBytes(this.#capacity);
    this.#prepareStep(tick);
    const encoder = this.#device.createCommandEncoder();
    this.#encodeStep(encoder, tick);
    encoder.copyBufferToBuffer(this.#events, 0, this.#eventReadback, 0, eventBytes);
    this.#device.queue.submit([encoder.finish()]);
    try {
      await this.#eventReadback.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(this.#eventReadback.getMappedRange().slice(0));
      return {
        ...decodePixelBlockGpuEvents(words, this.#capacity),
        readbackMs: performance.now() - started,
      };
    } finally {
      this.#eventReadback.unmap();
    }
  }

  async readCells(): Promise<Uint32Array> {
    this.#assertAlive();
    const bytes = this.#width * this.#height * Uint32Array.BYTES_PER_ELEMENT;
    const staging = this.#device.createBuffer({
      label: "event simulation cell readback",
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.#device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#state, 0, staging, 0, bytes);
    this.#device.queue.submit([encoder.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      return new Uint32Array(staging.getMappedRange().slice(0));
    } finally {
      staging.unmap();
      staging.destroy();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#device.queue.onSubmittedWorkDone();
    for (const buffer of this.#buffers) buffer.destroy();
    this.#device.destroy();
  }

  #prepareStep(tick: number): void {
    const plan = createPixelBlockGpuPlan(this.#width, this.#height, tick);
    this.#device.queue.writeBuffer(
      this.#params,
      0,
      new Uint32Array([
        this.#width,
        this.#height,
        tick,
        this.#seed,
        plan.blockColumns,
        plan.blockCount,
        this.#capacity,
        0,
      ]),
    );
    this.#device.queue.writeBuffer(this.#events, 0, new Uint32Array([0, 0, tick, 0]));
  }

  #encodeStep(encoder: GPUCommandEncoder, tick: number): void {
    const plan = createPixelBlockGpuPlan(this.#width, this.#height, tick);
    if (plan.workgroups === 0) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.dispatchWorkgroups(plan.workgroups);
    pass.end();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGPU event simulation is disposed");
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
