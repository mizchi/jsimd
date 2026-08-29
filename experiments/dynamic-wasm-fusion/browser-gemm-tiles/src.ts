import { measureF32GemmRowTile } from "../gemm_tile_measure.ts";

const parameters = new URLSearchParams(location.search);
void measureF32GemmRowTile({
  rows: integer("rows"),
  inner: integer("inner"),
  columns: integer("columns"),
  rowTile: rowTile(),
  warmups: integer("warmups"),
  samples: integer("samples"),
  operationsPerSample: integer("operations"),
}).then(
  (measurement) => report({ measurement, userAgent: navigator.userAgent }),
  reportError,
);

function integer(name: string): number {
  const value = Number(parameters.get(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function rowTile(): 1 | 2 | 4 | 8 {
  const value = integer("rowTile");
  if (value === 1 || value === 2 || value === 4 || value === 8) return value;
  throw new Error("invalid rowTile");
}

async function report(value: unknown): Promise<void> {
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function reportError(error: unknown): Promise<void> {
  await report({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
}
