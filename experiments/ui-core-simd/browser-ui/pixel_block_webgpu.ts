import {
  createPixelBlockGpuPlan,
  PIXEL_BLOCK_GPU_WORKGROUP_SIZE,
} from "../pixel_block_gpu_plan.ts";
import { DEFAULT_PIXEL_BLOCK_SEED } from "../pixel_block_sim.ts";
import { pixelBlockComputeShader } from "./pixel_block_shader.wgsl.ts";
import { pixelBrushShader, pixelRenderShader } from "./pixel_shaders.wgsl.ts";

const PARAMETER_BYTES = 32;
const RENDER_PARAMETER_BYTES = 16;

/** Resident race-free 2x2 block simulation; readCells is an explicit conformance-only readback. */
export class WebGpuBlockPixelSimulation implements AsyncDisposable {
  readonly residentBytes: number;
  readonly adapterInfo: GPUAdapterInfo;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #state: GPUBuffer;
  readonly #stepParams: GPUBuffer;
  readonly #brushParams: GPUBuffer;
  readonly #stepPipeline: GPUComputePipeline;
  readonly #brushPipeline: GPUComputePipeline;
  readonly #renderPipeline: GPURenderPipeline;
  readonly #stepBindGroup: GPUBindGroup;
  readonly #brushBindGroup: GPUBindGroup;
  readonly #renderBindGroup: GPUBindGroup;
  readonly #buffers: readonly GPUBuffer[];
  readonly #width: number;
  readonly #height: number;
  readonly #seed: number;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    state: GPUBuffer,
    stepParams: GPUBuffer,
    brushParams: GPUBuffer,
    stepPipeline: GPUComputePipeline,
    brushPipeline: GPUComputePipeline,
    renderPipeline: GPURenderPipeline,
    stepBindGroup: GPUBindGroup,
    brushBindGroup: GPUBindGroup,
    renderBindGroup: GPUBindGroup,
    buffers: readonly GPUBuffer[],
    width: number,
    height: number,
    seed: number,
    residentBytes: number,
    adapterInfo: GPUAdapterInfo,
  ) {
    this.#device = device;
    this.#context = context;
    this.#state = state;
    this.#stepParams = stepParams;
    this.#brushParams = brushParams;
    this.#stepPipeline = stepPipeline;
    this.#brushPipeline = brushPipeline;
    this.#renderPipeline = renderPipeline;
    this.#stepBindGroup = stepBindGroup;
    this.#brushBindGroup = brushBindGroup;
    this.#renderBindGroup = renderBindGroup;
    this.#buffers = buffers;
    this.#width = width;
    this.#height = height;
    this.#seed = seed;
    this.residentBytes = residentBytes;
    this.adapterInfo = adapterInfo;
  }

  static async create(
    canvas: HTMLCanvasElement,
    initialCells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_PIXEL_BLOCK_SEED,
  ): Promise<WebGpuBlockPixelSimulation> {
    if (initialCells.length !== width * height) throw new RangeError("initial cells do not match");
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter is unavailable");
    const device = await adapter.requestDevice();
    const buffers: GPUBuffer[] = [];
    try {
      const context = canvas.getContext("webgpu");
      if (context === null) throw new Error("WebGPU canvas context is unavailable");
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });
      const state = makeBuffer(
        device,
        "block pixel cells",
        initialCells.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      device.queue.writeBuffer(state, 0, initialCells.slice());
      const computeLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ],
      });
      const renderLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
      });
      const blockModule = device.createShaderModule({ code: pixelBlockComputeShader });
      const brushModule = device.createShaderModule({ code: pixelBrushShader });
      const renderModule = device.createShaderModule({ code: pixelRenderShader });
      await assertShaders([blockModule, brushModule, renderModule]);
      const computePipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [computeLayout],
      });
      const stepPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: { module: blockModule, entryPoint: "step" },
      });
      const brushPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: { module: brushModule, entryPoint: "paint" },
      });
      const renderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
        vertex: { module: renderModule, entryPoint: "vertexMain" },
        fragment: { module: renderModule, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      const stepParams = makeBuffer(
        device,
        "block step parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const brushParams = makeBuffer(
        device,
        "block brush parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const renderParams = makeBuffer(
        device,
        "block render parameters",
        RENDER_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      device.queue.writeBuffer(renderParams, 0, new Uint32Array([width, height, 0, 0]));
      const stepBindGroup = bindCompute(device, computeLayout, state, stepParams);
      const brushBindGroup = bindCompute(device, computeLayout, state, brushParams);
      const renderBindGroup = device.createBindGroup({
        layout: renderLayout,
        entries: [{ binding: 0, resource: { buffer: state } }, {
          binding: 1,
          resource: { buffer: renderParams },
        }],
      });
      const simulation = new WebGpuBlockPixelSimulation(
        device,
        context,
        state,
        stepParams,
        brushParams,
        stepPipeline,
        brushPipeline,
        renderPipeline,
        stepBindGroup,
        brushBindGroup,
        renderBindGroup,
        buffers,
        width,
        height,
        seed,
        initialCells.byteLength + PARAMETER_BYTES * 2 + RENDER_PARAMETER_BYTES,
        adapter.info,
      );
      await simulation.render();
      return simulation;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
      throw error;
    }
  }

  async step(tick: number): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const encoder = this.#device.createCommandEncoder();
    this.#encodeStep(encoder, tick);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  async stepAndRender(tick: number): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const encoder = this.#device.createCommandEncoder();
    this.#encodeStep(encoder, tick);
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  async paintAndRender(x: number, y: number, radius: number, material: number): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const integerRadius = Math.max(0, Math.floor(radius));
    const diameter = integerRadius * 2 + 1;
    const count = diameter * diameter;
    this.#device.queue.writeBuffer(
      this.#brushParams,
      0,
      new Uint32Array([this.#width, this.#height, x, y, integerRadius, material, diameter, count]),
    );
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#brushPipeline);
    pass.setBindGroup(0, this.#brushBindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / PIXEL_BLOCK_GPU_WORKGROUP_SIZE));
    pass.end();
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  async render(): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const encoder = this.#device.createCommandEncoder();
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  async readCells(): Promise<Uint32Array> {
    this.#assertAlive();
    const bytes = this.#width * this.#height * 4;
    const staging = this.#device.createBuffer({
      label: "block conformance readback",
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.#device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.#state, 0, staging, 0, bytes);
      this.#device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return new Uint32Array(staging.getMappedRange().slice(0));
    } finally {
      staging.unmap();
      staging.destroy();
    }
  }

  #encodeStep(encoder: GPUCommandEncoder, tick: number): void {
    const plan = createPixelBlockGpuPlan(this.#width, this.#height, tick);
    this.#device.queue.writeBuffer(
      this.#stepParams,
      0,
      new Uint32Array([
        this.#width,
        this.#height,
        tick,
        this.#seed,
        plan.blockColumns,
        plan.blockCount,
        0,
        0,
      ]),
    );
    if (plan.workgroups === 0) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#stepPipeline);
    pass.setBindGroup(0, this.#stepBindGroup);
    pass.dispatchWorkgroups(plan.workgroups);
    pass.end();
  }

  #encodeRender(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.#context.getCurrentTexture().createView(),
        clearValue: { r: 0.045, g: 0.063, b: 0.082, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.#renderPipeline);
    pass.setBindGroup(0, this.#renderBindGroup);
    pass.draw(3);
    pass.end();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#device.queue.onSubmittedWorkDone();
    for (const buffer of this.#buffers) buffer.destroy();
    this.#device.destroy();
    this.#context.unconfigure();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGPU block simulation is disposed");
  }
}

function bindCompute(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  state: GPUBuffer,
  params: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: state } }, {
      binding: 1,
      resource: { buffer: params },
    }],
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

async function assertShaders(modules: readonly GPUShaderModule[]): Promise<void> {
  const compilations = await Promise.all(modules.map((module) => module.getCompilationInfo()));
  const errors = compilations.flatMap((compilation) =>
    compilation.messages.filter((message) => message.type === "error")
  );
  if (errors.length > 0) throw new Error(errors.map((message) => message.message).join("\n"));
}
