import { WasmActiveSimdPixelBlock } from "../pixel_block_active_kernel.ts";
import { createPixelScenario, MATERIAL, type PixelMaterial } from "../pixel_sim.ts";
import { installPixelWorker } from "./pixel_worker_runtime.ts";

const MATERIAL_COLORS = [
  0xff15100c,
  0xff615950,
  0xff3db0f0,
  0xffe88c2e,
  0xffd98acb,
] as const;

installPixelWorker(async (width, height, occupancy, region) => {
  const initial = createPixelScenario(width, height, occupancy, 0x51f1_5e5d, region);
  const simulation = await WasmActiveSimdPixelBlock.create(initial, width, height);
  return {
    cells: simulation.cells,
    simulation,
    materialColors: MATERIAL_COLORS,
    normalizeMaterial: asBlockMaterial,
  };
});

function asBlockMaterial(value: number): PixelMaterial {
  if (
    value === MATERIAL.empty || value === MATERIAL.wall || value === MATERIAL.sand ||
    value === MATERIAL.water || value === MATERIAL.gas
  ) return value;
  return MATERIAL.sand;
}
