# `@mizchi/jsimd-validator`

Wasm SIMDでtyped numeric arrayを検証する小さなvalidatorです。公開APIはSIMD版だけです。 scalar
validatorは精度・性能比較用の内部assetとしてrepositoryには残しますが、package exportsにも npm
tarballにも含めません。

```sh
pnpm add @mizchi/jsimd-validator
```

```ts
import { compileSimd, float32Array, int32Array, maxValue, minValue } from "@mizchi/jsimd-validator";

const Ages = await compileSimd(int32Array(minValue(0), maxValue(130)));

Ages.is(new Int32Array([18, 36, 130])); // true
Ages.firstInvalid(new Int32Array([18, 131])); // 1
Ages.safeParse(new Int32Array([18, 131]));
// { success: false, issues: [{ code: "max_value", args: [130], path: [1] }] }
```

以前の`@mizchi/jsimd-validator/simd` subpathはありません。root entry pointを使います。

## Public API

- schemas: `int32Array`, `uint32Array`, `uint8Array`, `float32Array`, `float64Array`
- actions: `minValue`, `maxValue`
- compiler: `compileSimd`
- compiled validator: `is`, `firstInvalid`, `safeParse`, `resident`

範囲はinclusiveです。未対応actionを型キャスト等で渡しても黙って近似せず、schema生成時に
`TypeError`をthrowします。境界値にはfinite numberだけを受理します。

## SIMD execution

各schemaは専用の128-bit Wasm SIMD kernelを使い、scalar tailを含めて最初の不正indexを保持します。
通常のtyped array入力ではWasm memoryへのcopyを含みます。

```ts
const Values = await compileSimd(float32Array(minValue(0), maxValue(1)));
const resident = Values.resident(1_000_000);

resident.input.set(source);
resident.is(); // copyなし
resident.firstInvalid();
```

Wasm memoryがgrowすると古いresident viewはstaleになります。そのviewを使うと、切断されたmemoryを
暗黙に読む代わりに明示的にthrowします。

## IEEE 754

Float32/Float64はfiniteなIEEE 754値を対象とします。

- signed zeroとsubnormalを受理
- `NaN`と`+Infinity`/`-Infinity`を拒否
- Float32の境界を方向付きでbinary32へ丸め、JavaScriptの直接比較と同じ結果を維持

```ts
const Probability = await compileSimd(float32Array(maxValue(0.1)));
const input = new Float32Array([0.1]);

input[0] > 0.1; // true: binary32への丸め結果
Probability.is(input); // false
```

## Diagnostics

失敗はmessage文字列ではなく、軽量な`code + args + path`として返します。message formattingは
debug/logging時だけ`@mizchi/jsimd-validator/debug`から読み込みます。

```ts
import { formatIssue } from "@mizchi/jsimd-validator/debug";

const result = Ages.safeParse(new Int32Array([131]));
if (!result.success) console.error(formatIssue(result.issues[0]));
```

## Scope

このpackageは一般的なobject schema libraryではありません。公開対象は、同型の数値列をまとめて
走査できる次のlow-level subsetだけです。

- 5種類のtyped array
- inclusive min/max
- finite float
- 最初の不正index
- copy-inclusive / resident validation

object、string、union、transform、coercion、custom refinement、async validation等は受理しません。
JSON-likeなscalar schemaのAOT生成は別package
[`@mizchi/jsimd-validator-compiler`](../validator-compiler/README.md)が担当します。

## Current measurements

末尾を不正値にした、全要素走査のlocal benchmarkです。2026-09-01にDeno 2.6.4 / V8 14.2 / Apple
M5で計測した実験値であり、cross-runtimeの保証ではありません。

| kind | elements | JavaScript scalar | SIMD, copy included | SIMD, resident |
| ---- | -------: | ----------------: | ------------------: | -------------: |
| i32  |       32 |           35.8 ns |             86.9 ns |        55.5 ns |
| i32  |    1,024 |            1.1 µs |            462.6 ns |       433.1 ns |
| i32  |   65,536 |          103.1 µs |             30.1 µs |        20.5 µs |
| f32  |       32 |           65.6 ns |            124.7 ns |        73.5 ns |
| f32  |    1,024 |            1.9 µs |            518.0 ns |       429.0 ns |
| f32  |   65,536 |          121.2 µs |             28.2 µs |        20.7 µs |
| f64  |       32 |           67.2 ns |            131.0 ns |        69.8 ns |
| f64  |    1,024 |            2.0 µs |            718.5 ns |       560.0 ns |
| f64  |   65,536 |          128.5 µs |             44.2 µs |        28.5 µs |

短いcopy-inclusive入力はWasm境界のcostでscalarに負けます。1,024要素以上の列と、すでにWasm
memory上にあるresident列が主対象です。

```sh
just test-validator
just build-validator-package
just check-validator-tree-shake
just measure-validator-bundles
```

validator専用workflowはvalidator関連pathが変わった時だけ動き、比較benchmarkは手動実行です。
