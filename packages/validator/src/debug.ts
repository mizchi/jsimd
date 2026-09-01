import type { ValidationIssue } from "./diagnostics.ts";

export function formatIssueMessage(issue: ValidationIssue): string {
  switch (issue.code) {
    case "type":
      return `Expected ${issue.args[0]}`;
    case "required":
      return "Expected required property";
    case "literal":
      return `Expected ${JSON.stringify(issue.args[0])}`;
    case "union":
      return "Expected union";
    case "integer":
      return "Expected integer";
    case "min_value":
      return `Expected >= ${issue.args[0]}`;
    case "max_value":
      return `Expected <= ${issue.args[0]}`;
    case "greater_than":
      return `Expected > ${issue.args[0]}`;
    case "less_than":
      return `Expected < ${issue.args[0]}`;
    case "min_length":
      return `Expected length >= ${issue.args[0]}`;
    case "max_length":
      return `Expected length <= ${issue.args[0]}`;
    case "unknown_key":
      return "Expected no additional properties";
    case "never":
      return "Expected no value";
    case "invalid_json":
      return "Invalid JSON";
  }
}

export function formatIssue(issue: ValidationIssue): string {
  const message = formatIssueMessage(issue);
  return `Invalid ${formatPath(issue.path)}: ${message[0]!.toLowerCase()}${message.slice(1)}`;
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map(formatIssue).join("\n");
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "input";
  let output = "";
  for (const segment of path) {
    if (typeof segment === "number") output += `[${segment}]`;
    else if (output === "") output = segment;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) output += `.${segment}`;
    else output += `[${JSON.stringify(segment)}]`;
  }
  return output;
}
