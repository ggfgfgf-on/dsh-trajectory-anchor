# dsh-trajectory-anchor

Self-contained DeepSeek Harness bundle (v0.5.1). It observes one agent's
trajectory, anchors the first round, and speaks exactly two kinds of
behavioral reminders. It deliberately does **not** promise effects: every
mechanism that was ever measured and found null / low-precision /
structurally unreachable has been removed (slim rewrite, `ablation-log.md`
§61). What remains is:

1. **Observation & audit** — per-step lexicon-weighted trajectory scoring
   (we / let-me ratio, persona-ratio bands, session-local baseline
   percentile, EWMA), evidence capture (verifications / edits / completion
   claims), an append-only chunked audit log
   (`<workspace>/.dsh-trajectory-logs/anchor-<agentId>.jsonl`), reward
   annotation, and the read-only `anchor_status` tool.
2. **First-round anchoring** — a three-piece mechanism applied at the first
   request: bootstrap tool allow-list (`bash` / `str_replace_editor` /
   `pwsh`), a Minimal persona, and runtime-context + skill-catalog
   suppression. The tool surface is **derived at assembly time** (the
   unpromoted request only receives the bootstrap allow-list); no
   `tools.restrict()` call exists anywhere in the runtime, so the old
   "context restored but tool surface didn't" split is structurally
   impossible. Promotion is gated (`anchor-gate` lexical check) with a
   step-cap fallback; every degradation path exposes the full catalog and
   logs loudly.
3. **Two behavioral reminders** (both informational, both default OFF):
   - **L1 pullback** — on a *scope violation* or *code edits after the last
     verification*, a one-line reminder in the recency position. Throttled
     (once per turn, `pullbackMaxPerSession` per session), suggested
     phrasing with an explicit exemption, and a randomized control arm
     (`pullbackControlRate`) so its effect is measurable.
   - **L2' confirm-reanchor** — only on an *in-turn confirmation* that
     something is wrong (user correction / unknown tool / verification
     failed after a done-claim), the first-round Minimal payload is put back
     in the recency position, once per session, with a randomized control
     arm. It does not predict; it responds to confirmed problems.

No rollback, no capability layer, no delivery gates, no fact mirrors: those
families were deleted after measurement (P1 −0.25 p=0.890; Q1' 0.00 p=1.000;
ark anchoring A/B −2.6 p=0.254; lexicon buckets do not move scores). The
evidence trail lives in `ablation-log.md` (kept as the historical ledger) and
`docs/`.

## Configuration (21 keys, all optional)

Fresh install needs zero configuration; every key has a default and unknown
keys are loudly warned and ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `anchorEnabled` | `true` | Enable first-round anchoring |
| `bootstrapTools` | `['bash','str_replace_editor','pwsh']` | First-round tool allow-list (intersected with what the agent sees) |
| `bootstrapMaxTokens` | `null` | Optional first-round maxTokens cap (`null` = no cap) |
| `bootstrapPersona` | `'You are a helpful software engineer assistant.'` | First-round persona |
| `gateEnabled` | `true` | Promotion gate on (lexical anchor-gate) |
| `maxBootstrapSteps` | `5` | Step-cap fallback for promotion |
| `suppressContextOnBootstrap` | `true` | Suppress runtime context during bootstrap |
| `suppressSkillCatalog` | `true` | Suppress the skill catalog during bootstrap |
| `suppressedSources` | `['skill-catalog']` | Message-source kinds suppressed during bootstrap |
| `lexicon` | built-in | Scoring dictionary (positive/negative/neutral buckets) |
| `lexiconPath` | `null` | Optional JSON file to replace the dictionary |
| `pullbackEnabled` | `false` | L1 informational pullback (measure first) |
| `pullbackMaxPerSession` | `3` | L1 reminders per session |
| `pullbackControlRate` | `0` | Fraction of triggers deliberately not spoken (control arm) |
| `reanchorOnConfirm` | `false` | L2' confirm-reanchor |
| `reanchorConfirmControlRate` | `0` | Control arm for L2' |
| `pullbackOutcomePath` | `null` | Outcome JSONL path (default: audit dir) |
| `exportTrajectoryLogs` | `true` | Write per-agent trajectory JSONL |
| `logDir` | `.dsh-trajectory-logs` | Audit directory |
| `auditChunkEvents` | `400` | Audit buffer threshold (events) |
| `auditChunkBytes` | `262144` | Audit buffer threshold (bytes) |

## Tools

- `anchor_status` — read-only live audit (anchored/lifted state, bootstrap
  allow-list, scores, evidence counts, pullback/reanchor state, audit tail).

## Repository layout

- `index.js` — the whole runtime (pure predicates in `tools/task-anchor-core.mjs`)
- `tools/` — test suites, offline instruments, replay tools, mirror script
- `ablation-log.md` — the historical ledger of every mechanism, measurement and
  verdict (kept in the development workspace, not shipped with the bundle)
- `docs/` — historical design documents (kept for reference)
