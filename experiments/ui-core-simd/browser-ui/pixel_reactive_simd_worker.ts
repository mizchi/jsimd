import { WasmReactiveActiveSimdPixelBlock } from "../pixel_reactive_active_kernel.ts";
import { PixelEventTape } from "../pixel_event_tape.ts";
import {
  createPixelMaterialShowcase,
  MATERIAL,
  type PixelMaterial,
  seedPixelMaterialShowcaseInteractions,
} from "../pixel_sim.ts";
import { timelineMicros } from "../pixel_worker_timing.ts";
import { installPixelWorker } from "./pixel_worker_runtime.ts";

const MATERIAL_COLORS = [
  0xff15100c,
  0xff615950,
  0xff3db0f0,
  0xffe88c2e,
  0xffd98acb,
  0xff4b4bff,
  0xff8a827c,
  0xff3569a8,
  0xff241912,
  0xff7a7470,
  0xff4bda58,
  0xff1e55ff,
] as const;

installPixelWorker(async (width, height, occupancy, region, eventBuffer) => {
  if (eventBuffer === undefined) throw new Error("reaction Worker requires an event tape");
  const initial = createPixelMaterialShowcase(width, height, occupancy, 0x51f1_5e5d, region);
  const simulation = await WasmReactiveActiveSimdPixelBlock.create(initial, width, height);
  const eventTape = PixelEventTape.attach(eventBuffer);
  return {
    cells: simulation.cells,
    simulation: {
      step(tick: number) {
        if (tick > 0 && tick % 90 === 0) {
          seedPixelMaterialShowcaseInteractions(simulation.cells, width, height, region);
          simulation.activateRect(0, Math.floor(height / 2), width - 1, height - 1);
        }
        const result = simulation.step(tick);
        if (result.reactions > 0) {
          eventTape.markPublished(timelineMicros(performance.timeOrigin, performance.now()));
        }
        simulation.flushEvents(eventTape);
        return result;
      },
      activateRect(left: number, top: number, right: number, bottom: number) {
        simulation.activateRect(left, top, right, bottom);
      },
      get activeChunkCount() {
        return simulation.activeChunkCount;
      },
    },
    materialColors: MATERIAL_COLORS,
    normalizeMaterial: asReactiveMaterial,
  };
});

function asReactiveMaterial(value: number): PixelMaterial {
  if (Number.isInteger(value) && value >= MATERIAL.empty && value <= MATERIAL.lava) {
    return value as PixelMaterial;
  }
  return MATERIAL.sand;
}
