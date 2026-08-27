# Experimental OLAP execution design

Status: design note only. Nothing in this document is admitted to the implementation queue or the
public package API. Each layer still requires an end-to-end benchmark against optimized JavaScript
and DuckDB-Wasm before implementation.

## Motivation

The current experiment demonstrates a useful narrow boundary: persistent Workers can scan one
immutable, non-nullable i32 column with a hand-assembled SIMD count/sum kernel faster than both the
single-threaded and experimental threaded DuckDB-Wasm bundles. The result does not establish an
advantage for general analytical queries.

The next level of generality would be a typed physical execution substrate, not a SQL frontend.
DuckDB's execution engine moves horizontal slices of columns through operators as `DataChunk`s; its
vectors support physical representations such as flat, constant, and dictionary layouts. A jsimd
experiment should reuse the existing resident column, mask, hash, snapshot, and shared-memory
structures rather than duplicate them behind database-specific names.

Sources:

- [DuckDB internals overview](https://duckdb.org/docs/current/internals/overview)
- [DuckDB data chunks](https://duckdb.org/docs/current/clients/c/data_chunk)
- [DuckDB vectors](https://duckdb.org/docs/lts/clients/c/vector)
- [DuckDB aggregate states](https://github.com/duckdb/duckdb/blob/main/extension/core_functions/aggregate/README.md)

## Non-goals

- SQL parsing, binding, optimization, or a catalog
- transactions and MVCC
- arbitrary JavaScript values as keys
- general-purpose ART/B-tree indexes
- window functions, external sorting, or a spill manager before memory pressure is measured
- claiming that a specialized kernel is a complete DuckDB replacement

## Proposed physical structures

### 1. `ValidityMask`

Keep nullability distinct from query selection even if both use packed bits:

```text
ValidityMask  = which logical values exist
SelectionMask = which rows continue through the current pipeline
```

Required bulk behavior is validity-aware filtering and aggregation without materializing row IDs.

### 2. `PhysicalVector` and `ExecutionChunk`

An `ExecutionChunk` is a non-owning horizontal view over equally sized column vectors and one
resident selection mask. Storage pages remain larger and independently versioned.

```ts
type PhysicalVector =
  | FlatVector
  | ConstantVector
  | DictionaryVector
  | AdaptivePageVector
  | NullableVector;

interface ExecutionChunk {
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly columns: readonly PhysicalVector[];
  readonly selection: SelectionMask;
}
```

Existing adaptive i32/u32/u8 columns and `SelectionMask` should supply the first implementations.
The abstraction is only useful if operators can scan encoded vectors directly; a mandatory decode
into flat vectors would erase the current advantage.

### 3. `AggregateStateBlock`

Use structure-of-arrays state for count, sum, min, max, null count, and the sum/count pair needed by
average. Workers update private state and combine it only after a barrier. Aggregate state should
remain resident and use scaled integers before adding a general decimal contract.

### 4. `LocalGroupHashTableU32`

Start with u8/u16/u32 or packed small-integer keys and dictionary IDs. Reuse the existing SIMD
fingerprint/hash kernels, but store group IDs and aggregate-state indices instead of JavaScript
values.

```text
Worker-local group tables
        -> hash/radix partitions
        -> ownership-based parallel merge
        -> aggregate-state combine
```

Do not begin with a concurrently mutated global table.

### 5. `PartitionedHashJoinTable`

The minimum join substrate consists of resident hash values, u32 row IDs, radix partition offsets,
duplicate-key chains, and a caller-owned output buffer of matching row-ID pairs. An optional blocked
Bloom filter may reject absent probe keys. Each partition should have one build/probe owner.

### 6. `DictionaryStringColumn`

Compose the existing byte-key hash table and compressed string table so execution sees only u32
dictionary IDs. String decoding stays outside scan, group-by, and join hot paths.

### 7. `VersionedRowGroup`

Replace whole-column double buffering with immutable page handles. A new generation reuses unchanged
pages and allocates only replacements; reader guards delay page reuse. This is the bridge to the
existing memory, IndexedDB, and filesystem page backends.

### 8. `RadixSortBlock`

Only u32/u64 keys and row IDs are initially in scope. This supports partitioning, deterministic
group merge, dictionary construction, and later order/top-k experiments without a generic
comparison-sort API.

## Possible evaluation order

This is a hypothesis list, not an implementation order:

1. `ValidityMask`
2. `PhysicalVector` plus `ExecutionChunk`
3. `AggregateStateBlock`
4. `LocalGroupHashTableU32`
5. parallel low-cardinality group-by
6. `PartitionedHashJoinTable`
7. `DictionaryStringColumn`
8. `VersionedRowGroup`
9. `RadixSortBlock`

The first admission workloads would be a TPC-H Q6-shaped multi-column filter/expression/sum and a
Q1-shaped packed-key group-by with multiple aggregates. Both must report copy-inclusive setup,
resident warm execution, worker scaling, null handling, memory amplification, and bundled size.

## Relationship to current code

| Proposed role             | Existing reusable component                      |
| :------------------------ | :----------------------------------------------- |
| query selection           | `SelectionMask`                                  |
| encoded numeric vectors   | adaptive i32/u32/u8 columns                      |
| immutable publication     | `VersionedBuffer`                                |
| row-group pruning         | parallel columnar page descriptors and zone maps |
| worker-local scheduling   | SPSC rings, wait group, atomic page claims       |
| numeric/fixed-key hashing | flat hash and fingerprint-group kernels          |
| dictionary bytes          | `CompressedStringTable`, `ByteKeyFlatHashMapU32` |
| persisted pages           | columnar schema-engine page backends             |

The design should move to a separate repository if it grows a planner, catalog, schema lifecycle, or
product-facing query API. jsimd should retain only independently useful low-level structures and
their benchmark evidence.
