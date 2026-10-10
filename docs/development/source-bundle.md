# Source Bundle Loading & Validation

`loadSourceBundle` reads and validates a **service-owned, immutable, access-controlled**
inspection directory into an in-memory `SourceBundle`. It is a pure reader: it never
writes, repairs, migrates, or re-derives artifacts.

## Preconditions (trusted by the loader)

- The directory is owned and access-controlled by the service; no other principal can
  mutate it during or after a load in a way the loader is expected to detect.
- `fs` access and the object registry are injected/trusted. The loader canonicalizes
  bundle bytes to detect post-validation tampering, but it does **not** provide a
  mutable-filesystem TOCTOU guarantee: a file that changes after its bytes were read is
  not re-checked.
- Callers obtain an object capability by calling `getValidatedSourceBundle(bundle)`.
  Only bundles produced by a successful `loadSourceBundle` are accepted; structural
  clones, forged, or subsequently mutated objects are rejected.

## What is preserved

- Raw text, physical units, and the table candidate (`status: candidate_not_reviewed`)
  are preserved verbatim from source.
- Image blocks carry only `semanticStatus: 'not_run'`. There is **no OCR and no visual
  understanding**; image regions are opaque bytes with integrity metadata only.

## Trust boundaries / limits

| Limit               | Value      |
| ------------------- | ---------- |
| Source file         | 25 MiB     |
| JSON artifacts      | 8 MiB      |
| Per asset           | 32 MiB     |
| Total (all reads)   | 256 MiB    |
| Pages               | 40         |
| Blocks              | 5000       |
| Render pixel side   | 2400       |

Stable error codes (no raw content or host path leakage): `manifest_invalid`,
`artifact_path_unsafe`, `artifact_not_regular_file`, `artifact_missing`,
`size_limit_exceeded`, `hash_mismatch`, `count_mismatch`, `block_mismatch`,
`table_invalid`, `failure_marker_present`, `internal_error`, `invalid_source_bundle`,
plus `schema_invalid` / `identity_mismatch`.

## Commands

```sh
tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict \
  --skipLibCheck --allowImportingTsExtensions --verbatimModuleSyntax \
  --erasableSyntaxOnly --types node \
  apps/server/src/domain/source-bundle.ts tests/integration/source-bundle.test.ts

node --test tests/integration/source-bundle.test.ts
```