import {
  add,
  constant,
  createF32FusionCompiler,
  input,
  multiply,
  relu,
} from "../../packages/jsimd/src/f32-fusion/mod.ts";

using compiler = createF32FusionCompiler({ maxModules: 4 });
const expression = relu(add(multiply(input(0), constant(1.5)), constant(-0.5)));
const compiled = await compiler.compile(expression, 1);
const memory = new WebAssembly.Memory({ initial: 1 });
const inputPointer = 0;
const outputPointer = 64;
new Float32Array(memory.buffer, inputPointer, 4).set([1, -2, 3, 4]);
const kernel = await compiled.instantiate(memory);
kernel.run([inputPointer], outputPointer, 4);
document.body.textContent = Array.from(new Float32Array(memory.buffer, outputPointer, 4)).join(",");
