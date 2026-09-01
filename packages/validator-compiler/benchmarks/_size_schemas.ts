export interface AotSizeSchema {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly valid: unknown;
}

const wideProperties = Object.fromEntries(
  Array.from({ length: 16 }, (_, index) => [
    `field${index}`,
    index % 4 === 0
      ? { type: "string", minLength: 1, maxLength: 32 }
      : index % 4 === 1
      ? { type: "integer", minimum: 0, maximum: 1_000 }
      : index % 4 === 2
      ? { type: "boolean" }
      : { enum: ["a", "b", "c"] },
  ]),
);

const wideValid = Object.fromEntries(
  Array.from({ length: 16 }, (_, index) => [
    `field${index}`,
    index % 4 === 0 ? "value" : index % 4 === 1 ? index : index % 4 === 2 ? true : "a",
  ]),
);

export const aotSizeSchemas: readonly AotSizeSchema[] = [
  {
    name: "boolean",
    description: "primitive",
    schema: { type: "boolean" },
    valid: true,
  },
  {
    name: "bounded-string",
    description: "string + min/max length",
    schema: { type: "string", minLength: 4, maxLength: 32 },
    valid: "validator",
  },
  {
    name: "bounded-integer",
    description: "integer + min/max value",
    schema: { type: "integer", minimum: 0, maximum: 1_000 },
    valid: 42,
  },
  {
    name: "literal-union",
    description: "four string literals",
    schema: { enum: ["draft", "published", "archived", "deleted"] },
    valid: "published",
  },
  {
    name: "bounded-array",
    description: "bounded integer array",
    schema: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 100 },
      minItems: 1,
      maxItems: 64,
    },
    valid: [0, 50, 100],
  },
  {
    name: "flat-object",
    description: "four fields, one optional",
    schema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 0 },
        name: { type: "string", minLength: 1, maxLength: 32 },
        active: { type: "boolean" },
        note: { type: "string", maxLength: 128 },
      },
      required: ["id", "name", "active"],
      additionalProperties: true,
    },
    valid: { id: 1, name: "Ada", active: true },
  },
  {
    name: "strict-object",
    description: "six fields + unknown-key rejection",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 16 },
        age: { type: "integer", minimum: 0, maximum: 130 },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" }, maxItems: 4 },
        role: { enum: ["admin", "user"] },
        nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["name", "age", "active", "tags", "role"],
      additionalProperties: false,
    },
    valid: { name: "Ada", age: 36, active: true, tags: [], role: "admin" },
  },
  {
    name: "nested-object",
    description: "three object levels + array",
    schema: {
      type: "object",
      properties: {
        account: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                displayName: { type: "string", minLength: 1, maxLength: 24 },
                active: { type: "boolean" },
              },
              required: ["displayName", "active"],
              additionalProperties: true,
            },
            scores: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 100 },
              minItems: 1,
              maxItems: 8,
            },
          },
          required: ["profile", "scores"],
          additionalProperties: true,
        },
      },
      required: ["account"],
      additionalProperties: true,
    },
    valid: {
      account: {
        profile: { displayName: "Ada", active: true },
        scores: [0, 50, 100],
      },
    },
  },
  {
    name: "object-union",
    description: "three object alternatives",
    schema: {
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "text" }, value: { type: "string", maxLength: 128 } },
          required: ["kind", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "count" }, value: { type: "integer", minimum: 0 } },
          required: ["kind", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "flag" }, value: { type: "boolean" } },
          required: ["kind", "value"],
          additionalProperties: false,
        },
      ],
    },
    valid: { kind: "text", value: "hello" },
  },
  {
    name: "wide-object-16",
    description: "16 required strict fields",
    schema: {
      type: "object",
      properties: wideProperties,
      required: Object.keys(wideProperties),
      additionalProperties: false,
    },
    valid: wideValid,
  },
];
