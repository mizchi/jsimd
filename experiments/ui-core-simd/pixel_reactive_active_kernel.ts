import {
  PIXEL_EVENT_RECORD_WORDS,
  type PixelEventKind,
  type PixelEventSink,
} from "./pixel_event_tape.ts";
import {
  type PixelBlockActiveKernelStepResult,
  WasmActiveSimdPixelBlock,
} from "./pixel_block_active_kernel.ts";
import {
  type WasmPixelReactionStepResult,
  WasmSimdPixelReaction,
} from "./pixel_reaction_kernel.ts";

export interface PixelReactiveActiveStepResult extends PixelBlockActiveKernelStepResult {
  readonly reactions: number;
  readonly droppedEvents: number;
}

/** One resident world shared by active 2x2 movement and full-grid SIMD thermal reactions. */
export class WasmReactiveActiveSimdPixelBlock {
  readonly movement: WasmActiveSimdPixelBlock;
  readonly reaction: WasmSimdPixelReaction;
  #lastReaction: WasmPixelReactionStepResult | undefined;

  private constructor(
    movement: WasmActiveSimdPixelBlock,
    reaction: WasmSimdPixelReaction,
  ) {
    this.movement = movement;
    this.reaction = reaction;
  }

  static async create(
    cells: Uint32Array,
    width: number,
    height: number,
    eventCapacity = 256,
  ): Promise<WasmReactiveActiveSimdPixelBlock> {
    const requiredBytes = WasmSimdPixelReaction.requiredBytes(width, height, eventCapacity);
    const movement = await WasmActiveSimdPixelBlock.create(
      cells,
      width,
      height,
      undefined,
      32,
      requiredBytes,
    );
    const reaction = await WasmSimdPixelReaction.attach(
      movement.memory,
      width,
      height,
      eventCapacity,
    );
    return new WasmReactiveActiveSimdPixelBlock(movement, reaction);
  }

  step(tick: number): PixelReactiveActiveStepResult {
    const movement = this.movement.step(tick);
    const reaction = this.reaction.step();
    this.#lastReaction = reaction;
    for (let event = 0; event < reaction.events.length; event += PIXEL_EVENT_RECORD_WORDS) {
      const index = reaction.events[event + 1]! >>> 0;
      const x = index % this.reaction.width;
      const y = Math.floor(index / this.reaction.width);
      this.movement.activateRect(x, y, x, y);
    }
    return {
      ...movement,
      reactions: reaction.reactions,
      droppedEvents: reaction.dropped,
    };
  }

  flushEvents(tape: PixelEventSink): number {
    const reaction = this.#lastReaction;
    if (reaction === undefined) return 0;
    tape.recordDropped(reaction.dropped);
    let written = 0;
    for (let event = 0; event < reaction.events.length; event += PIXEL_EVENT_RECORD_WORDS) {
      if (
        tape.push(
          reaction.events[event]! as PixelEventKind,
          reaction.events[event + 1]! >>> 0,
          reaction.events[event + 2]! >>> 0,
          reaction.events[event + 3]! >>> 0,
        )
      ) written++;
    }
    this.#lastReaction = undefined;
    return written;
  }

  activateRect(left: number, top: number, right: number, bottom: number): void {
    this.movement.activateRect(left, top, right, bottom);
  }

  get cells(): Uint32Array {
    return this.reaction.cells;
  }

  get activeChunkCount(): number {
    return this.movement.activeChunkCount;
  }

  get chunkCount(): number {
    return this.movement.chunkCount;
  }

  get residentBytes(): number {
    return this.movement.residentBytes;
  }
}
