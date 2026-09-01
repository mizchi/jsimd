export interface Output { readonly "id": string; readonly "age": number; readonly "role": "admin" | "member"; readonly "active": boolean; readonly "tags": readonly (string)[]; readonly "profile": { readonly "displayName": string; readonly "score": number; }; readonly "nickname"?: string | null; }
export interface IssueArguments {
  readonly type: readonly [expected: string];
  readonly required: readonly [];
  readonly literal: readonly [expected: string | number | boolean | null];
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
export type ValidationIssue<Code extends IssueCode = IssueCode> = Code extends IssueCode ? { readonly code: Code; readonly args: IssueArguments[Code]; readonly path: readonly (string | number)[] } : never;
export type ValidationResult = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly [ValidationIssue] };
export interface StandardIssue { readonly message: string; readonly path: readonly (string | number)[]; }
export type StandardValidationResult = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly [StandardIssue] };
export declare function is(input: unknown): input is Output;
export declare function validate(input: unknown): ValidationResult;
export declare const schema: { readonly "~standard": { readonly version: 1; readonly vendor: "jsimd-validator/aot"; readonly validate: (input: unknown) => StandardValidationResult; readonly types?: { readonly input: unknown; readonly output: Output } } };
export default schema;
