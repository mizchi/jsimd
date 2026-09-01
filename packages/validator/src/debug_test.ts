import { formatIssue, formatIssueMessage, formatIssues } from "./debug.ts";
import type { ValidationIssue } from "./diagnostics.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("debug formatter renders enum-like issues outside the core validator", () => {
  const issues: readonly ValidationIssue[] = [
    { code: "type", args: ["string"], path: ["profile", "name"] },
    { code: "min_value", args: [18], path: ["ages", 1] },
    { code: "literal", args: ["admin"], path: ["role"] },
  ];

  assertEquals(formatIssueMessage(issues[0]!), "Expected string", "type message");
  assertEquals(formatIssue(issues[0]!), "Invalid profile.name: expected string", "object path");
  assertEquals(formatIssue(issues[1]!), "Invalid ages[1]: expected >= 18", "array path");
  assertEquals(
    formatIssues(issues),
    'Invalid profile.name: expected string\nInvalid ages[1]: expected >= 18\nInvalid role: expected "admin"',
    "multiple debug issues",
  );
});
