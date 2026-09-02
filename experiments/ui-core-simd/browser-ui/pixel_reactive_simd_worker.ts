import { WasmReactiveActiveSimdPixelBlock } from "../pixel_reactive_active_kernel.ts";
import { PixelEventTape } from "../pixel_event_tape.ts";
import { createPixelScenario, MATERIAL, type PixelMaterial } from "../pixel_sim.ts";
import { installPixelWorker } from "./pixel_worker_runtime.ts";

const MATERIAL_COLORS = [
  0xff15100c,
  0xff615950,
  0xff3db0f0,
  0xffe88c2e,
  0xffd98acb,
  0xff4b4bff,
] as const;

installPixelWorker(async (width, height, occupancy, region, eventBuffer) => {
  if (eventBuffer === undefined) throw new Error("reaction Worker requires an event tape");
  const initial = createPixelScenario(width, height, occupancy, 0x51f1_5e5d, region);
  const simulation = await WasmReactiveActiveSimdPixelBlock.create(initial, width, height);
  const eventTape = PixelEventTape.attach(eventBuffer);
  return {
    cells: simulation.cells,
    simulation: {
      step(tick: number) {
        const result = simulation.step(tick);
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
  if (
    value === MATERIAL.empty || value === MATERIAL.wall || value === MATERIAL.sand ||
    value === MATERIAL.water || value === MATERIAL.gas || value === MATERIAL.fire
  ) return value;
  return MATERIAL.sand;
}
