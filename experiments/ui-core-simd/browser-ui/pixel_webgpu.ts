import { createPixelPassPlan, PIXEL_WORKGROUP_SIZE } from "../pixel_pass_plan.ts";
import { pixelBrushShader, pixelComputeShader, pixelRenderShader } from "./pixel_shaders.wgsl.ts";

const PARAMETER_BYTES = 32;
const RENDER_PARAMETER_BYTES = 16;

interface PassResources {
  readonly bindGroup: GPUBindGroup;
  readonly workgroups: number;
}

interface PhaseResources {
  readonly vertical: PassResources;
  readonly diagonal: PassResources;
  readonly horizontal: PassResources;
}

export class WebGpuPixelSimulation implements AsyncDisposable {
  readonly residentBytes: number;
  readonly adapterInfo: GPUAdapterInfo;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  readonly #state: GPUBuffer;
  readonly #brushParams: GPUBuffer;
  readonly #verticalPipeline: GPUComputePipeline;
  readonly #diagonalPipeline: GPUComputePipeline;
  readonly #horizontalPipeline: GPUComputePipeline;
  readonly #brushPipeline: GPUComputePipeline;
  readonly #renderPipeline: GPURenderPipeline;
  readonly #phases: readonly [PhaseResources, PhaseResources];
  readonly #brushBindGroup: GPUBindGroup;
  readonly #renderBindGroup: GPUBindGroup;
  #disposed = false;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    state: GPUBuffer,
    brushParams: GPUBuffer,
    verticalPipeline: GPUComputePipeline,
    diagonalPipeline: GPUComputePipeline,
    horizontalPipeline: GPUComputePipeline,
    brushPipeline: GPUComputePipeline,
    renderPipeline: GPURenderPipeline,
    phases: readonly [PhaseResources, PhaseResources],
    brushBindGroup: GPUBindGroup,
    renderBindGroup: GPUBindGroup,
    residentBytes: number,
    adapterInfo: GPUAdapterInfo,
  ) {
    this.#device = device;
    this.#context = context;
    this.#format = format;
    this.#state = state;
    this.#brushParams = brushParams;
    this.#verticalPipeline = verticalPipeline;
    this.#diagonalPipeline = diagonalPipeline;
    this.#horizontalPipeline = horizontalPipeline;
    this.#brushPipeline = brushPipeline;
    this.#renderPipeline = renderPipeline;
    this.#phases = phases;
    this.#brushBindGroup = brushBindGroup;
    this.#renderBindGroup = renderBindGroup;
    this.residentBytes = residentBytes;
    this.adapterInfo = adapterInfo;
  }

  static async create(
    canvas: HTMLCanvasElement,
    initialCells: Uint32Array,
    width: number,
    height: number,
  ): Promise<WebGpuPixelSimulation> {
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
        "pixel material cells",
        initialCells.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      device.queue.writeBuffer(state, 0, initialCells.slice());
      const computeLayout = device.createBindGroupLayout({
        label: "pixel compute bindings",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" },
          },
        ],
      });
      const renderLayout = device.createBindGroupLayout({
        label: "pixel render bindings",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });
      const computeModule = device.createShaderModule({
        label: "pixel pair passes",
        code: pixelComputeShader,
      });
      const brushModule = device.createShaderModule({
        label: "pixel brush",
        code: pixelBrushShader,
      });
      const renderModule = device.createShaderModule({
        label: "pixel renderer",
        code: pixelRenderShader,
      });
      await assertShaders([computeModule, brushModule, renderModule]);
      const computePipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [computeLayout],
      });
      const verticalPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: { module: computeModule, entryPoint: "vertical" },
      });
      const diagonalPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: { module: computeModule, entryPoint: "diagonal" },
      });
      const horizontalPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: { module: computeModule, entryPoint: "horizontal" },
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

      const parameterBuffers: GPUBuffer[] = [];
      const phases = [0, 1].map((phase) => {
        const plan = createPixelPassPlan(width, height, phase);
        return {
          vertical: makePass(
            device,
            computeLayout,
            state,
            width,
            height,
            phase,
            plan.verticalPairs,
            plan.verticalWorkgroups,
            parameterBuffers,
            buffers,
          ),
          diagonal: makePass(
            device,
            computeLayout,
            state,
            width,
            height,
            phase,
            plan.diagonalPairs,
            plan.diagonalWorkgroups,
            parameterBuffers,
            buffers,
          ),
          horizontal: makePass(
            device,
            computeLayout,
            state,
            width,
            height,
            phase,
            plan.horizontalPairs,
            plan.horizontalWorkgroups,
            parameterBuffers,
            buffers,
          ),
        };
      }) as unknown as [PhaseResources, PhaseResources];
      const brushParams = makeBuffer(
        device,
        "pixel brush parameters",
        PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const brushBindGroup = device.createBindGroup({
        layout: computeLayout,
        entries: [{ binding: 0, resource: { buffer: state } }, {
          binding: 1,
          resource: { buffer: brushParams },
        }],
      });
      const renderParams = makeBuffer(
        device,
        "pixel render parameters",
        RENDER_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        buffers,
      );
      device.queue.writeBuffer(renderParams, 0, new Uint32Array([width, height, 0, 0]));
      const renderBindGroup = device.createBindGroup({
        layout: renderLayout,
        entries: [{ binding: 0, resource: { buffer: state } }, {
          binding: 1,
          resource: { buffer: renderParams },
        }],
      });
      const residentBytes = initialCells.byteLength + parameterBuffers.length * PARAMETER_BYTES +
        PARAMETER_BYTES + RENDER_PARAMETER_BYTES;
      const simulation = new WebGpuPixelSimulation(
        device,
        context,
        format,
        state,
        brushParams,
        verticalPipeline,
        diagonalPipeline,
        horizontalPipeline,
        brushPipeline,
        renderPipeline,
        phases,
        brushBindGroup,
        renderBindGroup,
        residentBytes,
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

  async stepAndRender(phase: number): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const resources = this.#phases[phase & 1]!;
    const encoder = this.#device.createCommandEncoder({ label: "pixel simulation tick" });
    encodeCompute(encoder, this.#verticalPipeline, resources.vertical);
    encodeCompute(encoder, this.#diagonalPipeline, resources.diagonal);
    encodeCompute(encoder, this.#horizontalPipeline, resources.horizontal);
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  async paintAndRender(
    x: number,
    y: number,
    radius: number,
    material: number,
  ): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const integerRadius = Math.max(0, Math.floor(radius));
    const diameter = integerRadius * 2 + 1;
    const count = diameter * diameter;
    this.#device.queue.writeBuffer(
      this.#brushParams,
      0,
      new Uint32Array([this.width, this.height, x, y, integerRadius, material, diameter, count]),
    );
    const encoder = this.#device.createCommandEncoder({ label: "pixel brush" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#brushPipeline);
    pass.setBindGroup(0, this.#brushBindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / PIXEL_WORKGROUP_SIZE));
    pass.end();
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  }

  get width(): number {
    return this.#context.canvas.width;
  }

  get height(): number {
    return this.#context.canvas.height;
  }

  async render(): Promise<number> {
    this.#assertAlive();
    const started = performance.now();
    const encoder = this.#device.createCommandEncoder({ label: "pixel render" });
    this.#encodeRender(encoder);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    return performance.now() - started;
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
    this.#state.destroy();
    this.#brushParams.destroy();
    this.#device.destroy();
    this.#context.unconfigure();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WebGPU pixel simulation is disposed");
  }
}

function makePass(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  state: GPUBuffer,
  width: number,
  height: number,
  parity: number,
  pairCount: number,
  workgroups: number,
  parameterBuffers: GPUBuffer[],
  allBuffers: GPUBuffer[],
): PassResources {
  const parameters = makeBuffer(
    device,
    "pixel pass parameters",
    PARAMETER_BYTES,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    allBuffers,
  );
  parameterBuffers.push(parameters);
  device.queue.writeBuffer(
    parameters,
    0,
    new Uint32Array([width, height, parity, pairCount, 0, 0, 0, 0]),
  );
  return {
    bindGroup: device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: state } }, {
        binding: 1,
        resource: { buffer: parameters },
      }],
    }),
    workgroups,
  };
}

function encodeCompute(
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  resources: PassResources,
): void {
  if (resources.workgroups === 0) return;
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, resources.bindGroup);
  pass.dispatchWorkgroups(resources.workgroups);
  pass.end();
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
