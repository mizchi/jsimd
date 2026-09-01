function numericSchema(offset) {
  const properties = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: offset + index, maximum: offset + index + 100 },
    ]),
  );
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const Packet = numericSchema(0);
export const Telemetry = numericSchema(100);
