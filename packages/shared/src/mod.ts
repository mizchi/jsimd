/**
 * Stable package boundary for the shared-memory runtime.
 *
 * The implementation remains in @mizchi/jsimd during the compatibility window so existing
 * `@mizchi/jsimd/shared-buffer` imports keep working without duplicating the Wasm binary.
 */
export * from "@mizchi/jsimd/shared-buffer";
