# GenUI Gate

**A deterministic quality and accessibility gate for agent-generated UI.** Protocol-agnostic, A2UI first. Apache-2.0, no telemetry, no accounts.

Agents increasingly emit UI declarations (A2UI and friends) that hosts render directly. Nothing in that pipeline answers: *is this structure sound? how big is it? can it hurt the host? is it accessible?* GenUI Gate answers those questions deterministically — think ESLint + Lighthouse for agent UI, plus a runtime gate (roadmap).

> Status: M0 (headless reporter). Internal design docs are Chinese for now; English docs land with the 0.x releases.

<!-- Demo GIF lands here once recorded:
![genui-audit demo](docs/demo.gif)
-->

## The CLI in 30 seconds

```console
$ node packages/audit/bin/genui-audit.mjs official-samples/live-invitation-builder.json

GenUI Gate audit report
=======================

Input: 5705 bytes (sha256 7b662fb0de1d80a576d894b74d4b8aedfbb02d7a76db77f07833070cbfcbcc6a)

Surfaces: 1 (1 live), components: 20, nodes: 20
Adapter issues: 0

Surface "gallery-invitation-builder" (https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json)
  Components: 20, nodes: 20, max depth: 7
  IR hash: 2efbebdc3dd0976206b3ba1b431c5bf1c95a932c44b57ec1f99e2a87e1fb4c85
  Verdict: pass
  A11y baseline: 20 nodes, 0 with accessibility metadata, 0 with label, 0 with description, 0 live region, 0 hidden
  Rule violations: none

Overall: PASS
```

And when a spec goes wrong — a 33-deep card stack, exactly the DoS shape limits exist for:

```console
$ node packages/audit/bin/genui-audit.mjs too-deep.json

GenUI Gate audit report
=======================

Input: 1564 bytes (sha256 618f537998cb0a3d189bf4d1d7d07b0dc936aa61e6a5ceeb48ce759fec507451)

Surfaces: 1 (1 live), components: 33, nodes: 33
Adapter issues: 0

Surface "too-deep" [blocked]
  Components: 33, nodes: 33, max depth: 33
  IR hash: b77e502b1e76c3666343365493f09576b6b98750ad66ec259f31652134fca71b
  Verdict: block
  A11y baseline: 33 nodes, 0 with accessibility metadata, 0 with label, 0 with description, 0 live region, 0 hidden
  Rule: limits.tree-depth (critical/block) x1
    <root>/slots.child[0]/.../slots.child[0]: depth 33 exceeds limit 32

Overall: BLOCK (1 surface(s) blocked)

$ echo $?
2
```

## Quick start

Requires Node >= 20 and pnpm 11 (M0 runs from the repo; `npm i -g genui-audit` lands with the first release).

```bash
git clone https://github.com/AH23333/GenUI-Gate.git genui-gate
cd genui-gate
pnpm install

# audit any A2UI spec: single message, message array, JSONL, or example wrapper
node packages/audit/bin/genui-audit.mjs your-spec.json        # text report
node packages/audit/bin/genui-audit.mjs your-spec.json --json # machine-readable
```

Exit codes: `0` audit passed · `1` usage / file read error · `2` audit blocked (parse error, no surfaces, or a blocked surface).

## What it checks today (M0)

| Layer | Checks |
|---|---|
| **Parse + adapt** | A2UI v0.9.x and v1.0 wire formats (JSONL, arrays, example wrappers); 17 adapter issue codes: missing/duplicate component ids, dangling child refs, reference cycles, invalid envelopes, bad JSON pointers... |
| **Limits (DoS hard caps)** | tree depth 32 · 2000 nodes · 64 children per node · 16 KB per prop — fail-closed, every violation carries an explainable trace (`ruleId` + node path + reason) |
| **Deterministic identity** | canonical JSON + sha256: same input, same IR hash, every platform — locked by cross-platform pipeline goldens in CI |
| **A11y baseline** | factual accessibility-metadata coverage per surface (label / description / live region / hidden) — policy rules land in M1 |

The whole official A2UI fixture corpus (53 examples, v0.9.1 + v1.0) is embedded as a golden test set — every one parses, adapts, and audits deterministically.

## Determinism is the product

- Core packages (`ir`, `gate`, `adapter`) are **zero-dependency, pure, synchronous** — no `Date.now()`, no `Math.random()`, no locale-sensitive comparison.
- Canonical JSON is a strict JCS (RFC 8785) subset; sha256 is a pure-TS implementation cross-checked against NIST vectors and `node:crypto`.
- All tree traversal uses explicit stacks — a 10k-deep tree cannot overflow the call stack.
- The full pipeline (parse → adapt → hash → gate) over the whole official corpus is digest-pinned; CI re-verifies identical hashes on ubuntu/windows × Node 20/22.
- Bench (A6 budget, 500 nodes / depth 12): `gate()` p99 **0.81 ms** against a **5 ms** budget, no memoization needed.

## Repository layout

```
packages/
  ir/             IR model, canonical JSON, sync sha256
  gate/           limits enforcement + verdict aggregation
  adapter-a2ui/   A2UI message streams -> IR (official corpus as goldens)
  audit/          genui-audit CLI (headless report, text + --json)
scripts/
  bench-gate.ts   A6 budget bench (deterministic 500-node/depth-12 tree)
docs/             product design, execution log, pitfalls (Chinese for now)
```

## Development

```bash
pnpm install     # install
pnpm test        # 188 tests, incl. property tests + official-corpus goldens
pnpm typecheck   # tsc --noEmit
pnpm coverage    # coverage thresholds 90/90/85/90
pnpm bench       # gate p99 vs 5ms budget (exit 0/2)
```

## Roadmap

- **M0 (done)** — headless reporter: `genui-audit` CLI, deterministic pipeline, official-corpus goldens, bench.
- **M1** — policy engine (a11y rule pack: heading structure / landmarks / focus order, per-rule `off|shadow|enforce`), session + runtime gate, pending-inert, spec rollback.
- **M2** — framework integration (`gate-react`), public *GenUI accessibility field survey* built with this CLI.

Scope and milestones: [docs/产品设计v3-开源版.md](docs/产品设计v3-开源版.md) · full technical spec: [docs/产品设计v2-修订.md](docs/产品设计v2-修订.md).

## License

Apache-2.0. Embedded A2UI fixtures are upstream materials under their own Apache-2.0 license (see [packages/adapter-a2ui/test/fixtures/official/ATTRIBUTION.md](packages/adapter-a2ui/test/fixtures/official/ATTRIBUTION.md)).
