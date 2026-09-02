import { WasmActiveSimdPixelBlock } from "../pixel_block_active_kernel.ts";
import { createPixelScenario, MATERIAL, type PixelMaterial } from "../pixel_sim.ts";
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
  if (Number.isInteger(value) && value >= MATERIAL.empty && value <= MATERIAL.lava) {
    return value as PixelMaterial;
  }
  return MATERIAL.sand;
}
