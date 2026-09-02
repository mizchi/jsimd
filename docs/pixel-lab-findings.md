# Pixel Labからjsimdへ還元する知見

Pixel物理の実装・デモ・ベンチマークは
[`mizchi/pixel-lab`](https://github.com/mizchi/pixel-lab)へ移管した。この文書には、汎用SIMD・
Atomics・UIランタイム設計へ還元できる結論だけを残す。移管元の最終スナップショットは
jsimdの`fd849e3`、完全な実験記録はpixel-labの
[`RESEARCH.md`](https://github.com/mizchi/pixel-lab/blob/main/RESEARCH.md)を参照する。

## SIMDが効く境界

- SIMDが強いのは、連続したrow-majorデータに同じ規則を適用し、少なくとも数万要素を走査する場合。
- 2x2ブロックを4 laneへ集めるWasm SIMDは、256x160から1024x640までscalar block比で
  computeを約2.7--3.3倍高速化した。Wasm常駐メモリによりtickごとの再packを避けることが前提。
- 素材数を6から12へ増やしても、descriptor tableと`i8x16.swizzle`による分類なら素材数に比例した
  比較列を追加せずに済む。規則数ではなく、全セルで必ず行う近傍分類が固定費になる。
- SIMDは不規則な分岐や小さなdirty setを自動的には救わない。汎用APIでは、dense batchを明示的な
  SIMD entrypointへ送り、小さいbatchはscalarに残すべき。

## denseとsparseの分岐

32x32 chunk schedulerは、1024x640のspotケースでfull SIMDよりcomputeを約2.5倍高速化した一方、
ほぼ全chunkがactiveなfullケースでは約13%遅かった。したがって、sparse schedulerはSIMD kernelの
置き換えではなく、active率を観測して選ぶ外側のdispatch policyである。

UIのsignal graphにも同じ構造がある。高fan-outの固定graphはpacked dense rowとSIMD unionが向くが、
少数の購読者や頻繁に変わる依存関係はscalar adjacencyの方が小さく速い。

## Atomicsとoff-thread ownership

- DOM `PointerEvent`自体はWorkerへ渡せない。main threadでtarget-local座標、buttons、pointer ID、
  timestampなど必要なprimitiveだけを同期的に抽出し、固定長`SharedArrayBuffer`へ書く。
- pointer moveはlatest-value slotでcoalesceし、click/down/upは小さなFIFO ringに分離すると、
  moveの割り当てとqueue成長を避けながらdiscrete eventの順序を保持できる。
- `Atomics.waitAsync`またはwake sequenceによりWorkerをrAFから独立して起こせる。ただし改善するのは
  main-thread待ち時間とownershipであり、kernel単体のcompute時間ではない。
- OffscreenCanvasは40,960 cellでは移管費を回収できず、655,360 cellではmain-thread pixel workと
  shared snapshotを大きく削減した。小さいsurfaceではmain-thread renderingを残すpolicyが妥当。

## WebGPUの境界

WebGPUはstateとrenderingをGPUに常駐させるdenseな1024x640 worldで有効だった。毎tickの完全な
readbackは避ける必要がある。CPU側が結果を使う場合は、固定容量のsemantic event bufferへ圧縮し、
readback cadenceとoverflowを明示的なcontractにする。それでもreadback latencyがゲームロジックの
依存鎖に入るならWasm SIMDの方が扱いやすい。

## UIコアへの適用

CanvasではWorkerが最終presentationまで所有できるが、DOM nodeのmutationはmain threadに残る。
したがってPixel Labの速度をDOM UIへ直接外挿してはいけない。UIコアではWorker/SIMDが生成した
numeric resultをcompact patch tapeへ変換し、main threadで一括適用する境界が必要になる。

また、Wasm、Atomics DOM adapter、Worker、WebGPUはすべてoptional entrypointに分ける。Pixel Labで
有効だった機能でも、signalsの最小entrypointへ混ぜれば、小規模UIで固定のdownload/instantiate費を
課すことになる。性能採用条件にはruntime測定と同時にgzip上限を置く。
