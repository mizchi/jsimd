import { strictNumericComparison } from "./_wasm_library_comparison.ts";

let sink: unknown;

for (const width of [8, 32, 128]) {
  const scenario = await strictNumericComparison(width);
  for (const validator of scenario.validators) {
    Deno.bench({ name: validator.name, group: `${width} fields / valid` }, () => {
      sink = validator.check(scenario.valid);
    });
    Deno.bench({ name: validator.name, group: `${width} fields / early invalid` }, () => {
      sink = validator.check(scenario.earlyInvalid);
    });
    Deno.bench({ name: validator.name, group: `${width} fields / late invalid` }, () => {
      sink = validator.check(scenario.lateInvalid);
    });
  }

  Deno.bench({ name: "compile Wasm.Module", group: `${width} fields / initialization` }, () => {
    sink = new WebAssembly.Module(scenario.wasmBytes);
  });
  Deno.bench(
    { name: "instantiate precompiled module", group: `${width} fields / initialization` },
    () => {
      sink = scenario.instantiateWasm(scenario.wasmModule);
    },
  );
  Deno.bench(
    { name: "compile + instantiate bytes", group: `${width} fields / initialization` },
    () => {
      sink = scenario.instantiateWasm(scenario.wasmBytes);
    },
  );
}

globalThis.addEventListener("unload", () => {
  if (sink === Symbol.for("never")) console.log(sink);
});
