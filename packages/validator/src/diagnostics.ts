export type LiteralValue = string | number | boolean | null;

export interface IssueArguments {
  readonly type: readonly [expected: string];
  readonly required: readonly [];
  readonly literal: readonly [expected: LiteralValue];
  readonly union: readonly [];
  readonly integer: readonly [];
  readonly min_value: readonly [requirement: number];
  readonly max_value: readonly [requirement: number];
  readonly greater_than: readonly [requirement: number];
  readonly less_than: readonly [requirement: number];
  readonly min_length: readonly [requirement: number];
  readonly max_length: readonly [requirement: number];
  readonly unknown_key: readonly [];
  readonly never: readonly [];
  readonly invalid_json: readonly [];
}

export type IssueCode = keyof IssueArguments;

export type ValidationIssue<Code extends IssueCode = IssueCode> = Code extends IssueCode ? {
    readonly code: Code;
    readonly args: IssueArguments[Code];
    readonly path: readonly (string | number)[];
  }
  : never;

export type SafeParseResult<Output> =
  | { readonly success: true; readonly output: Output }
  | { readonly success: false; readonly issues: readonly [ValidationIssue] };
