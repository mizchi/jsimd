export interface BrowserBenchmarkOptions<T> {
  readonly root: URL;
  readonly path?: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly resultPath?: string;
  readonly progressPath?: string;
  readonly timeoutMs?: number;
  readonly profilePrefix?: string;
  readonly browserExecutable?: string;
  readonly browserArgs?: readonly string[];
  readonly browserStderr?: "null" | "inherit";
  readonly crossOriginIsolated?: boolean;
  readonly validate?: (value: unknown) => asserts value is T;
  readonly onProgress?: (value: unknown) => void;
}

/** Runs one benchmark in a fresh headless Chromium profile and returns its posted JSON result. */
export async function runBrowserBenchmark<T = unknown>(
  options: BrowserBenchmarkOptions<T>,
): Promise<T> {
  const executable = options.browserExecutable ?? await findBrowserExecutable();
  if (executable === undefined) throw new Error("no Chrome-compatible executable found");
  const resultPath = options.resultPath ?? "/__jsimd_result";
  if (!resultPath.startsWith("/")) throw new RangeError("resultPath must be absolute");
  const progressPath = options.progressPath ?? "/__jsimd_progress";
  if (!progressPath.startsWith("/")) throw new RangeError("progressPath must be absolute");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 180_000, "timeoutMs");
  let listening: ((port: number) => void) | undefined;
  let reportResult: ((value: unknown) => void) | undefined;
  const portPromise = new Promise<number>((resolve) => listening = resolve);
  const report = new Promise<unknown>((resolve) => reportResult = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => listening?.(port),
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === resultPath && request.method === "POST") {
      reportResult?.(await request.json());
      return new Response("ok");
    }
    if (url.pathname === progressPath && request.method === "POST") {
      options.onProgress?.(await request.json());
      return new Response("ok");
    }
    try {
      const asset = resolveStaticAsset(options.root, url.pathname);
      return new Response(await Deno.readFile(asset), {
        headers: responseHeaders(asset.pathname, options.crossOriginIsolated ?? true),
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
      if (error instanceof RangeError) return new Response("invalid path", { status: 400 });
      throw error;
    }
  });
  const port = await portPromise;
  const profile = await Deno.makeTempDir({ prefix: options.profilePrefix ?? "jsimd-benchmark-" });
  const target = new URL(options.path ?? "/", `http://127.0.0.1:${port}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    target.searchParams.set(key, String(value));
  }
  try {
    const child = new Deno.Command(executable, {
      args: [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        ...(options.browserArgs ?? []),
        target.href,
      ],
      stdout: "null",
      stderr: options.browserStderr ?? "null",
    }).spawn();
    let timeout: number | undefined;
    try {
      const value = await Promise.race([
        report,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("browser benchmark timed out")), timeoutMs);
        }),
      ]);
      if (isRecord(value) && typeof value.error === "string") throw new Error(value.error);
      options.validate?.(value);
      return value as T;
    } finally {
      clearTimeout(timeout);
      try {
        child.kill("SIGTERM");
      } catch {
        // Chromium may have exited after posting an error.
      }
      await child.status;
    }
  } finally {
    await server.shutdown();
    await Deno.remove(profile, { recursive: true });
  }
}

export async function findBrowserExecutable(): Promise<string | undefined> {
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

export async function detectHostCpu(): Promise<string> {
  if (Deno.build.os === "darwin") {
    const output = await new Deno.Command("sysctl", {
      args: ["-n", "machdep.cpu.brand_string"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (output.success) return new TextDecoder().decode(output.stdout).trim() || "unavailable";
  }
  if (Deno.build.os === "linux") {
    try {
      const cpuInfo = await Deno.readTextFile("/proc/cpuinfo");
      const model = /^model name\s*:\s*(.+)$/m.exec(cpuInfo)?.[1]?.trim();
      if (model) return model;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return "unavailable";
}

export function resolveStaticAsset(root: URL, pathname: string): URL {
  const decoded = decodeURIComponent(pathname);
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new RangeError("asset path must stay inside fixture root");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = new URL(relative, root);
  if (!resolved.href.startsWith(root.href)) throw new RangeError("asset escaped fixture root");
  return resolved;
}

export function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function responseHeaders(path: string, isolated: boolean): HeadersInit {
  return {
    "content-type": contentType(path),
    ...(isolated
      ? {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      }
      : {}),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
