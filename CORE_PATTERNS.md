# moonbitlang/core SIMD pattern inventory

Source audit: 2026-08-25.

| core source                                  | high-level pattern                                      | jsimd status                                |
| -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `builtin/bytes_find.mbt`                     | forward/reverse byte scan                               | `indexOf`, `lastIndexOf`                    |
| `builtin/bytes_find.mbt`                     | first/last-byte SIMD prefilter plus middle verification | `indexOf`                                   |
| `builtin/bytesview.mbt`                      | lexicographical compare with first differing lane       | `compare`                                   |
| `builtin/bytes.mbt` intrinsic and byte views | equal byte ranges                                       | `equals`                                    |
| `encoding/utf16/decode.mbt`                  | surrogate detection and endian byte shuffle             | candidate; compare with `TextDecoder` first |
| `json/lex_string.mbt`                        | quote/backslash/control scan                            | candidate for UTF-8 bytes API               |
| `json/simd_lexer_utf8.mbt`                   | JSON classification and token-start extraction          | `jsonTokenStarts`                           |

The package intentionally exports algorithms rather than raw `v128` values. JavaScript cannot pass
`v128` across the Wasm boundary, and copying is only worthwhile when one call performs enough work.
Current kernels preserve core's scalar-prefix strategy so early differences and hits do not force a
full input copy.
