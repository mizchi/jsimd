import { aotSizeSchemas } from "../packages/validator-compiler/benchmarks/_size_schemas.ts";
import { compileSchema } from "../packages/validator-compiler/src/mod.ts";

const targets = ["boolean", "diagnostic", "standard"] as const;
const javascriptGzipBudgets = {
  boolean: 650,
  diagnostic: 1_450,
  standard: 1_800,
} as const;
const declarationGzipBudget = 650;

interface FileSize {
  readonly bytes: number;
  readonly gzip: number;
}

interface Measurement {
  readonly javascript: FileSize;
  readonly typescript: FileSize;
}

const measurements = new Map<string, Measurement>();

for (const target of targets) {
  console.log(`\n### ${target}\n`);
  console.log("| schema | shape | JavaScript | JS gzip | .d.ts | .d.ts gzip |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");

  for (const entry of aotSizeSchemas) {
    const artifact = compileSchema(entry.schema, { backend: "javascript", target });
    const measurement = {
      javascript: await measure(artifact.files.javascript),
      typescript: await measure(artifact.files.typescript),
    };
    if (measurement.javascript.gzip > javascriptGzipBudgets[target]) {
      throw new Error(
        `${entry.name}/${target}: JavaScript gzip ${measurement.javascript.gzip} exceeds ${
          javascriptGzipBudgets[target]
        } bytes`,
      );
    }
    if (measurement.typescript.gzip > declarationGzipBudget) {
      throw new Error(
        `${entry.name}/${target}: declaration gzip ${measurement.typescript.gzip} exceeds ${declarationGzipBudget} bytes`,
      );
    }
    measurements.set(`${entry.name}/${target}`, measurement);
    console.log(
      `| ${entry.name} | ${entry.description} | ${format(measurement.javascript.bytes)} | ${
        format(measurement.javascript.gzip)
      } | ${format(measurement.typescript.bytes)} | ${format(measurement.typescript.gzip)} |`,
    );
  }
}

for (const entry of aotSizeSchemas) {
  const boolean = measurements.get(`${entry.name}/boolean`)!;
  const diagnostic = measurements.get(`${entry.name}/diagnostic`)!;
  const standard = measurements.get(`${entry.name}/standard`)!;
  if (diagnostic.javascript.bytes <= boolean.javascript.bytes) {
    throw new Error(`${entry.name}: diagnostic output must include more runtime than boolean`);
  }
  if (standard.javascript.bytes <= diagnostic.javascript.bytes) {
    throw new Error(`${entry.name}: Standard output must include more runtime than diagnostic`);
  }
}

async function measure(source: string): Promise<FileSize> {
  const bytes = new TextEncoder().encode(source);
  const gzip = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  return { bytes: bytes.byteLength, gzip: gzip.byteLength };
}

function format(bytes: number): string {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}
