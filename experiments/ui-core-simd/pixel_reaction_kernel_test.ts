import { PIXEL_EVENT_RECORD_WORDS } from "./pixel_event_tape.ts";
import { stepPixelReactions } from "./pixel_reaction.ts";
import { WasmSimdPixelReaction } from "./pixel_reaction_kernel.ts";
import { MATERIAL, packPixel } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown, label = "value"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("Wasm SIMD reactions match scalar cells and compact events", async () => {
  for (const [width, height] of [[3, 1], [7, 5], [18, 9]] as const) {
    const initial = reactionFixture(width, height);
    const scalar = initial.slice();
    const scratch = new Uint32Array(initial.length);
    const simd = await WasmSimdPixelReaction.create(initial, width, height, 8);
    for (let tick = 0; tick < 12; tick++) {
      const expectedEvents: number[] = [];
      const expected = stepPixelReactions(
        scalar,
        scratch,
        width,
        height,
        (kind, index, before, after) => expectedEvents.push(kind, index, before, after),
      );
      const actual = simd.step();
      assertEquals(Array.from(simd.cells), Array.from(scalar), `${width}x${height} tick ${tick}`);
      assertEquals(actual.reactions, expected.reactions, "reaction count");
      assertEquals(
        Array.from(actual.events),
        expectedEvents.slice(0, 8 * PIXEL_EVENT_RECORD_WORDS),
        "event tape",
      );
      assertEquals(actual.dropped, Math.max(0, expected.reactions - 8), "dropped events");
    }
  }
});

Deno.test("Wasm SIMD reaction storage can attach to a preallocated movement memory", async () => {
  const initial = reactionFixture(16, 8);
  const bytes = WasmSimdPixelReaction.requiredBytes(16, 8, 4);
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65_536) });
  new Uint32Array(memory.buffer, 0, initial.length).set(initial);
  const reaction = await WasmSimdPixelReaction.attach(memory, 16, 8, 4);
  reaction.step();
  assertEquals(reaction.memory, memory);
  assertEquals(reaction.cells.buffer, memory.buffer);
});

function reactionFixture(width: number, height: number): Uint32Array {
  const cells = new Uint32Array(width * height);
  for (let index = 0; index < cells.length; index++) {
    const sample = index % 19;
    const material = sample === 0
      ? MATERIAL.fire
      : sample === 1
      ? MATERIAL.lava
      : sample < 6
      ? MATERIAL.water
      : sample < 9
      ? MATERIAL.gas
      : sample < 12
      ? MATERIAL.wood
      : sample < 15
      ? MATERIAL.oil
      : sample === 15
      ? MATERIAL.smoke
      : sample === 16
      ? MATERIAL.acid
      : sample === 17
      ? MATERIAL.stone
      : MATERIAL.empty;
    const temperature = material === MATERIAL.fire || material === MATERIAL.lava
      ? 255
      : material === MATERIAL.gas
      ? 64 + index % 32
      : material === MATERIAL.wood || material === MATERIAL.oil
      ? 176 + index % 32
      : 128 + index % 16;
    cells[index] = packPixel(material, temperature, index & 7, index & 15);
  }
  return cells;
}
