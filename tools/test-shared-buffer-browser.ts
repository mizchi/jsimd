const root = new URL("../examples/tree-shake-shared-buffer/dist/", import.meta.url);
const executable = await findBrowser();
if (executable === undefined) {
  console.log("SharedBuffer browser smoke skipped: no Chrome-compatible executable found");
  Deno.exit(0);
}

let listening: ((port: number) => void) | undefined;
const portPromise = new Promise<number>((resolve) => listening = resolve);
let reportResult: ((value: number) => void) | undefined;
const report = new Promise<number>((resolve) => reportResult = resolve);
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => listening?.(port),
}, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__jsimd_result" && request.method === "POST") {
    reportResult?.(Number(await request.text()));
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
const profile = await Deno.makeTempDir({ prefix: "jsimd-shared-buffer-browser-" });
try {
  const child = new Deno.Command(executable, {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}`,
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let timeout: number | undefined;
  try {
    const value = await Promise.race([
      report,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SharedBuffer browser Worker smoke timed out")),
          20_000,
        );
      }),
    ]);
    if (value !== 1) throw new Error(`SharedBuffer browser Worker returned ${value}`);
    console.log("SharedBuffer browser Worker smoke passed with cross-origin isolation");
  } finally {
    clearTimeout(timeout);
    try {
      child.kill("SIGTERM");
    } catch {
      // The browser may already have exited after reporting an error.
    }
    await child.status;
  }
} finally {
  await server.shutdown();
  await Deno.remove(profile, { recursive: true });
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
      const command = new Deno.Command("which", {
        args: [candidate],
        stdout: "piped",
        stderr: "null",
      });
      const result = await command.output();
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
