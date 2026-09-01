import { compileSchema, type GeneratedBooleanModule } from "../src/mod.ts";
import { aotSizeSchemas } from "./_size_schemas.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("size matrix covers distinct schema shapes and paired generated files", async () => {
  assert(aotSizeSchemas.length >= 10, "size matrix keeps broad shape coverage");
  assert(
    new Set(aotSizeSchemas.map((entry) => entry.name)).size === aotSizeSchemas.length,
    "schema names are unique",
  );

  for (const entry of aotSizeSchemas) {
    for (const target of ["boolean", "diagnostic", "standard"] as const) {
      const artifact = compileSchema(entry.schema, { backend: "javascript", target });
      assert(
        artifact.files.javascript === artifact.code,
        `${entry.name}/${target}: JavaScript pair`,
      );
      assert(
        artifact.files.typescript === artifact.declaration,
        `${entry.name}/${target}: TypeScript pair`,
      );
      assert(artifact.files.javascript.includes("export const is="), `${entry.name}/${target}: JS`);
      assert(artifact.files.typescript.includes("Output"), `${entry.name}/${target}: declaration`);
    }

    const artifact = compileSchema(entry.schema, { backend: "javascript", target: "boolean" });
    const generated = await importArtifact(artifact.files.javascript);
    assert(generated.is(entry.valid), `${entry.name}: generated validator accepts valid fixture`);
  }
});

async function importArtifact(code: string): Promise<GeneratedBooleanModule> {
  return await import(`data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`);
}
