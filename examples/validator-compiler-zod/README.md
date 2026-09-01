# Zod subset to standalone JavaScript validator

Wasm AOT対象外のnested schemaをJavaScript AOT fallbackへbuild-time compileし、Zodに依存しない
validatorを使うexampleです。

```sh
just build-validator-compiler-zod-example
just test-validator-compiler-zod-example
node examples/validator-compiler-zod/app.ts
```

packageをinstallしたprojectでは次のCLIを実行します。

```sh
pnpm exec jsimd-validator-compiler \
  examples/validator-compiler-zod/schema.ts#UserSchema \
  --out examples/validator-compiler-zod/generated/user \
  --javascript
```

このmonorepoの`just` recipeは、同じCLIのlocal build
`packages/validator-compiler/dist/cli.js`を直接実行します。

生成される`user.js`はZodもcompiler runtimeもimportしません。`user.d.ts`にはschemaから推論した
`Output`型と、boolean predicate・raw diagnostics・Standard Schema wrapperの型が含まれます。

このexampleで使うサブセット:

- strict nested object
- required / optional / nullable properties
- string min/max length
- finite number and integer min/max
- primitive enum
- homogeneous array min/max length

transform、coercion、default、custom refine、regex/formatなどは生成時に
`UnsupportedSchemaError`になります。
