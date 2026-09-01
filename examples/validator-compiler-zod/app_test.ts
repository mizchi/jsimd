import UserValidator, { is, validate } from "./generated/user.js";

const valid = {
  id: "user-1",
  age: 36,
  role: "member",
  active: true,
  tags: ["compiler"],
  profile: {
    displayName: "Ada",
    score: 0.95,
  },
  nickname: null,
} as const;

Deno.test("generated Zod-subset validator is dependency-free and standalone", async () => {
  const source = await Deno.readTextFile(new URL("./generated/user.js", import.meta.url));
  if (source.includes("zod")) throw new Error("generated validator retained Zod");
  if (/^\s*import\s/m.test(source)) throw new Error("generated validator retained an import");

  if (!is(valid)) throw new Error("valid fixture was rejected");
  if (!("value" in UserValidator["~standard"].validate(valid))) {
    throw new Error("generated Standard Schema wrapper rejected the valid fixture");
  }
});

Deno.test("generated predicate rejects unsupported values at every nested boundary", () => {
  const cases = [
    { ...valid, age: 131 },
    { ...valid, role: "owner" },
    { ...valid, tags: [] },
    { ...valid, profile: { ...valid.profile, displayName: "" } },
    { ...valid, extra: true },
  ];
  for (const input of cases) {
    if (is(input)) throw new Error(`invalid fixture was accepted: ${JSON.stringify(input)}`);
  }
});

Deno.test("generated raw diagnostics preserve code, arguments, and nested path", () => {
  const result = validate({
    ...valid,
    profile: { ...valid.profile, score: 2 },
  });
  if (result.issues === undefined) throw new Error("invalid score was accepted");
  const [issue] = result.issues;
  if (issue === undefined) throw new Error("diagnostic result did not contain an issue");
  if (
    issue.code !== "max_value" || issue.args[0] !== 1 ||
    JSON.stringify(issue.path) !== JSON.stringify(["profile", "score"])
  ) {
    throw new Error(`unexpected issue: ${JSON.stringify(issue)}`);
  }
});
