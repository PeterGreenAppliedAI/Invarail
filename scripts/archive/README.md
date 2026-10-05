# Archived scripts

One-off migrations, early FalkorDB experiments and probes whose job is done. Kept for the record
(several are cited in `DECISIONS.md`), not maintained, and not type-checked in CI. Run one only
after reading it — the migrations assume the data layout of their day.

| Script | What it was for |
|---|---|
| `migrate-to-principal.ts` | Moved per-channel memory under one principal (identity layer, 2026-08) |
| `migrate-facts-to-graph.ts`, `backfill-entities.ts` | Seeded the FalkorDB graph from the flat store |
| `test-falkordb.ts`, `test-falkordb-vectors.ts`, `test-graph-store.ts`, `test-graph-advanced.ts` | Early graph and vector-index experiments |
| `incident-routing-probe.ts`, `calendar-parse-probe.ts`, `format-probe.ts`, `prep-raw-probe.ts`, `think-probe-test.ts` | One-time probes behind specific DECISIONS entries |
