import { createPixelScenario, MATERIAL, type PixelMaterial } from "../pixel_sim.ts";
import { ActivePixelSimulation } from "./pixel_active_runtime.ts";
import { installPixelWorker } from "./pixel_worker_runtime.ts";

const MATERIAL_COLORS = [0xff15100c, 0xff615950, 0xff3db0f0, 0xffe88c2e] as const;

installPixelWorker((width, height, occupancy, region) => {
  const cells = createPixelScenario(width, height, occupancy, 0x51f1_5e5d, region);
  return {
    cells,
    simulation: ActivePixelSimulation.create(cells, width, height),
    materialColors: MATERIAL_COLORS,
    normalizeMaterial: asPairMaterial,
  };
});

function asPairMaterial(value: number): PixelMaterial {
  if (value === MATERIAL.empty || value === MATERIAL.wall || value === MATERIAL.sand) return value;
  return MATERIAL.water;
}
