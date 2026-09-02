import {
  decodePixelGpuEvents,
  type PixelGpuEventBatch,
  pixelGpuEventBytes,
} from "../pixel_gpu_event_buffer.ts";
import { pixelReactionEventComputeShader } from "./pixel_reaction_event_shader.wgsl.ts";

const PARAMETER_BYTES = 16;
const WORKGROUP_SIZE = 64;
const STAGING_BUFFER_COUNT = 3;

interface EventReadbackSlot {
  readonly buffer: GPUBuffer;
  busy: boolean;
}

export interface PixelReactionGpuEventReadback extends PixelGpuEventBatch {
  readonly readbackMs: number;
  readonly firstTick: number;
  readonly tickCount: number;
}

/** Explicit semantic reaction backend; state stays ping-ponged on GPU between bounded readbacks. */
export class WebGpuReactionEventSimulation implements AsyncDisposable {
  readonly residentBytes: number;
  readonly readbackBytes: number;
  readonly stagingBytes: number;
  readonly adapterInfo: GPUAdapterInfo;
  readonly #device: GPUDevice;
  readonly #states: readonly [GPUBuffer, GPUBuffer];
  readonly #params: GPUBuffer;
  readonly #events: GPUBuffer;
  readonly #eventReadbacks: readonly EventReadbackSlot[];
  readonly #pipeline: GPUComputePipeline;
  readonly #bindGroups: readonly [GPUBindGroup, GPUBindGroup];
  readonly #buffers: readonly GPUBuffer[];
  readonly #width: number;
  readonly #height: number;
  readonly #capacity: number;
  #phase: 0 | 1 = 0;
  #batchFirstTick = -1;
  #batchTickCount = 0;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    states: readonly [GPUBuffer, GPUBuffer],
    params: GPUBuffer,
    events: GPUBuffer,
    eventReadbacks: readonly EventReadbackSlot[],
    pipeline: GPUComputePipeline,
    bindGroups: readonly [GPUBindGroup, GPUBindGroup],
    buffers: readonly GPUBuffer[],
    width: number,
    height: number,
    capacity: number,
    adapterInfo: GPUAdapterInfo,
  ) {
    this.#device = device;
    this.#states = states;
    this.#params = params;
    this.#events = events;
    this.#eventReadbacks = eventReadbacks;
    this.#pipeline = pipeline;
    this.#bindGroups = bindGroups;
    this.#buffers = buffers;
    this.#width = width;
    this.#height = height;
    this.#capacity = capacity;
    this.readbackBytes = pixelGpuEventBytes(capacity);
    this.stagingBytes = this.readbackBytes * eventReadbacks.length;
    this.residentBytes = states[0].size + states[1].size + params.size + events.size;
    this.adapterInfo = adapterInfo;
  }

  static async create(
    initialCells: Uint32Array,
    width: number,
    height: number,
    capacity: number,
  ): Promise<WebGpuReactionEventSimulation> {
    if (initialCells.length !== width * height) {
      throw new RangeError("reaction input does not match");
    }
    const eventBytes = pixelGpuEventBytes(capacity);
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter is unavailable");
    const device = await adapter.requestDevice();
    const buffers: GPUBuffer[] = [];
    try {
      const stateBytes = initialCells.byteLength;
      const states = [
        makeBuffer(
          device,
          "reaction cells A",
          stateBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          buffers,
        ),
        makeBuffer(
          device,
          "reaction cells B",
          stateBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          buffers,
        ),
      ] as const;
      const params = makeBuffer(
        device,
        "reaction parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const events = makeBuffer(
        device,
        "bounded semantic reaction events",
        eventBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      const eventReadbacks = Array.from({ length: STAGING_BUFFER_COUNT }, (_, index) => ({
        buffer: makeBuffer(
          device,
          `semantic reaction event readback ${index}`,
          eventBytes,
          GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          buffers,
        ),
        busy: false,
      }));
      device.queue.writeBuffer(states[0], 0, initialCells.slice());
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const module = device.createShaderModule({ code: pixelReactionEventComputeShader });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter((message) => message.type === "error");
      if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("\n"));
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "step" },
      });
      const bindGroups = [
        createBindGroup(device, layout, states[0], states[1], params, events),
        createBindGroup(device, layout, states[1], states[0], params, events),
      ] as const;
      return new WebGpuReactionEventSimulation(
        device,
        states,
        params,
        events,
        eventReadbacks,
        pipeline,
        bindGroups,
        buffers,
        width,
        height,
        capacity,
        adapter.info,
      );
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
      throw error;
    }
  }

  step(tick: number): void {
    this.#assertAlive();
    if ((tick >>> 0) !== tick) throw new RangeError("reaction tick must be u32");
    if (this.#batchTickCount === 0) {
      this.#batchFirstTick = tick;
      this.#device.queue.writeBuffer(this.#events, 0, new Uint32Array([0, 0, tick, 0]));
    } else {
      if (tick !== this.#batchFirstTick + this.#batchTickCount) {
        throw new RangeError("reaction event batch ticks must be contiguous");
      }
      this.#device.queue.writeBuffer(this.#events, 8, new Uint32Array([tick]));
    }
    this.#device.queue.writeBuffer(
      this.#params,
      0,
      new Uint32Array([this.#width, this.#height, this.#capacity, tick]),
    );
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroups[this.#phase]);
    pass.dispatchWorkgroups(Math.ceil(this.#width * this.#height / WORKGROUP_SIZE));
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
    this.#phase = (this.#phase ^ 1) as 0 | 1;
    this.#batchTickCount++;
  }

  async readEvents(): Promise<PixelReactionGpuEventReadback> {
    this.#assertAlive();
    if (this.#batchTickCount === 0) throw new Error("reaction event batch is empty");
    const slot = this.#eventReadbacks.find((candidate) => !candidate.busy);
    if (slot === undefined) throw new Error("all reaction event staging buffers are busy");
    slot.busy = true;
    const started = performance.now();
    const firstTick = this.#batchFirstTick;
    const tickCount = this.#batchTickCount;
    const encoder = this.#device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#events, 0, slot.buffer, 0, this.readbackBytes);
    this.#device.queue.submit([encoder.finish()]);
    this.#batchFirstTick = -1;
    this.#batchTickCount = 0;
    try {
      await slot.buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(slot.buffer.getMappedRange().slice(0));
      return {
        ...decodePixelGpuEvents(words, this.#capacity),
        readbackMs: performance.now() - started,
        firstTick,
        tickCount,
      };
    } finally {
      slot.buffer.unmap();
      slot.busy = false;
    }
  }

  async stepAndReadEvents(tick: number): Promise<PixelReactionGpuEventReadback> {
    this.step(tick);
    return await this.readEvents();
  }

  async readCells(): Promise<Uint32Array> {
    this.#assertAlive();
    const bytes = this.#width * this.#height * Uint32Array.BYTES_PER_ELEMENT;
    const staging = this.#device.createBuffer({
      label: "reaction cell readback",
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.#device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#states[this.#phase], 0, staging, 0, bytes);
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

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGPU reaction simulation is disposed");
  }
}

function createBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  input: GPUBuffer,
  output: GPUBuffer,
  params: GPUBuffer,
  events: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: input } },
      { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: { buffer: params } },
      { binding: 3, resource: { buffer: events } },
    ],
  });
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
