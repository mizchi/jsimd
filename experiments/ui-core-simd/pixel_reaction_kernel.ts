import { PIXEL_EVENT_RECORD_WORDS } from "./pixel_event_contract.ts";
import { pixelReactionRequiredBytes, pixelReactionScratchOffset } from "./pixel_reaction_layout.ts";

interface PixelReactionKernelExports extends WebAssembly.Exports {
  step(
    cells: number,
    scratch: number,
    width: number,
    height: number,
    events: number,
    capacity: number,
  ): bigint;
}

export interface WasmPixelReactionStepResult {
  readonly reactions: number;
  readonly dropped: number;
  readonly events: Int32Array;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** SIMD temperature diffusion over a resident movement world with bounded compact events. */
export class WasmSimdPixelReaction {
  readonly memory: WebAssembly.Memory;
  readonly cells: Uint32Array;
  readonly width: number;
  readonly height: number;
  readonly eventCapacity: number;
  readonly #scratchOffset: number;
  readonly #eventOffset: number;
  readonly #kernel: PixelReactionKernelExports;

  private constructor(
    memory: WebAssembly.Memory,
    width: number,
    height: number,
    eventCapacity: number,
    kernel: PixelReactionKernelExports,
  ) {
    this.memory = memory;
    this.width = width;
    this.height = height;
    this.eventCapacity = eventCapacity;
    const cellBytes = width * height * Uint32Array.BYTES_PER_ELEMENT;
    this.#scratchOffset = pixelReactionScratchOffset(width, height);
    this.#eventOffset = this.#scratchOffset + cellBytes;
    this.cells = new Uint32Array(memory.buffer, 0, width * height);
    this.#kernel = kernel;
  }

  static requiredBytes(width: number, height: number, eventCapacity: number): number {
    return pixelReactionRequiredBytes(width, height, eventCapacity);
  }

  static async create(
    initial: Uint32Array,
    width: number,
    height: number,
    eventCapacity: number,
  ): Promise<WasmSimdPixelReaction> {
    if (initial.length !== width * height) throw new RangeError("reaction input does not match");
    const bytes = WasmSimdPixelReaction.requiredBytes(width, height, eventCapacity);
    const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65_536) });
    const reaction = await WasmSimdPixelReaction.attach(memory, width, height, eventCapacity);
    reaction.cells.set(initial);
    return reaction;
  }

  static async attach(
    memory: WebAssembly.Memory,
    width: number,
    height: number,
    eventCapacity: number,
  ): Promise<WasmSimdPixelReaction> {
    const required = WasmSimdPixelReaction.requiredBytes(width, height, eventCapacity);
    if (!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength < required) {
      throw new RangeError(`reaction memory must contain at least ${required} bytes`);
    }
    modulePromise ??= compileModule(new URL("./pixel_reaction_step.wasm", import.meta.url));
    const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
    return new WasmSimdPixelReaction(
      memory,
      width,
      height,
      eventCapacity,
      instance.exports as PixelReactionKernelExports,
    );
  }

  step(): WasmPixelReactionStepResult {
    const packed = this.#kernel.step(
      0,
      this.#scratchOffset,
      this.width,
      this.height,
      this.#eventOffset,
      this.eventCapacity,
    );
    const reactions = Number(packed & 0xffff_ffffn) >>> 0;
    const dropped = Number(packed >> 32n & 0xffff_ffffn) >>> 0;
    const emitted = Math.min(reactions, this.eventCapacity);
    return {
      reactions,
      dropped,
      events: new Int32Array(
        this.memory.buffer,
        this.#eventOffset,
        emitted * PIXEL_EVENT_RECORD_WORDS,
      ),
    };
  }
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load pixel reaction Wasm: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
