import { compileSchema } from "../packages/validator-compiler/src/mod.ts";

const source = (await import("../packages/validator-compiler/fixtures/schema.mjs")).User;
const configurations = [
  { name: "AOT boolean-only", target: "boolean" as const, jsonParser: false as const },
  { name: "AOT raw diagnostics", target: "diagnostic" as const, jsonParser: false as const },
  { name: "AOT Standard adapter", target: "standard" as const, jsonParser: false as const },
  {
    name: "AOT raw diagnostics + native parseJSON",
    target: "diagnostic" as const,
    jsonParser: "native" as const,
  },
];

console.log("| artifact | JavaScript | gzip |");
console.log("| --- | ---: | ---: |");
for (const configuration of configurations) {
  const artifact = compileSchema(source, {
    backend: "javascript",
    target: configuration.target,
    jsonParser: configuration.jsonParser,
  });
  const bytes = new TextEncoder().encode(artifact.code);
  const gzip = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  if (configuration.target === "boolean" && gzip.byteLength > 365) {
    throw new Error(`AOT boolean-only artifact exceeds gzip budget: ${gzip.byteLength} > 365`);
  }
  const budget = configuration.target === "standard"
    ? 950
    : configuration.jsonParser === "native"
    ? 700
    : configuration.target === "diagnostic"
    ? 625
    : undefined;
  if (budget !== undefined && gzip.byteLength > budget) {
    throw new Error(`${configuration.name} exceeds gzip budget: ${gzip.byteLength} > ${budget}`);
  }
  console.log(
    `| ${configuration.name} | ${format(bytes.byteLength)} | ${format(gzip.byteLength)} |`,
  );
}

function format(bytes: number): string {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}
