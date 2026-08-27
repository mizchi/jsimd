const root = new URL(
  "../experiments/parallel-columnar-query/duckdb-comparison/dist/",
  import.meta.url,
);
const executable = await findBrowser();
if (executable === undefined) throw new Error("no Chrome-compatible executable found");

const rows = parsePositiveInteger(Deno.env.get("JSIMD_QUERY_ROWS") ?? "33554432", "rows");
const modes = ["jsimd-single", "jsimd-workers", "duckdb-eh", "duckdb-coi"] as const;
const pending = new Map<string, (result: unknown) => void>();
let listening: ((port: number) => void) | undefined;
const portPromise = new Promise<number>((resolve) => listening = resolve);
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => listening?.(port),
}, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__jsimd_result" && request.method === "POST") {
    const result = await request.json();
    const mode = isResult(result) ? result.mode : undefined;
    if (mode !== undefined) pending.get(mode)?.(result);
    return new Response("ok");
  }
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (relative.includes("..")) return new Response("invalid path", { status: 400 });
  try {
    const body = await Deno.readFile(new URL(relative, root));
    return new Response(body, {
      headers: {
        "content-type": contentType(relative),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw error;
  }
});

const port = await portPromise;
const results: unknown[] = [];
try {
  for (const mode of modes) {
    const resultPromise = new Promise<unknown>((resolve) => pending.set(mode, resolve));
    const profile = await Deno.makeTempDir({ prefix: `jsimd-duckdb-${mode}-` });
    const child = new Deno.Command(executable, {
      args: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${port}/?mode=${mode}&rows=${rows}`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    let timeout: number | undefined;
    try {
      const result = await Promise.race([
        resultPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${mode} timed out`)), 180_000);
        }),
      ]);
      if (isResult(result) && typeof result.error === "string") throw new Error(result.error);
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      clearTimeout(timeout);
      pending.delete(mode);
      try {
        child.kill("SIGTERM");
      } catch {
        // Chrome may already have exited after reporting an error.
      }
      await child.status;
      await Deno.remove(profile, { recursive: true });
    }
  }
  console.log(JSON.stringify({ rows, results }, null, 2));
} finally {
  await server.shutdown();
}

function isResult(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

async function findBrowser(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("CHROME_BIN"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (!candidate.includes("/")) {
      const result = await new Deno.Command("which", {
        args: [candidate],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (result.success) return new TextDecoder().decode(result.stdout).trim();
      continue;
    }
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
