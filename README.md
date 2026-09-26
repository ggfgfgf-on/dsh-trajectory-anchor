# dsh-trajectory-anchor

A self-contained DeepSeek Harness bundle: first-round trajectory anchoring, EWMA trajectory scoring,
adaptive drift rollback, anchorGate promotion gating, bootstrap context suppression, trajectory-log
export with process-reward annotation, and a Layer-4 training-data aggregator.
**Zero community-plugin dependencies** — one line to mount.

> Every mechanism in this bundle was validated live on this harness family as a dynamic-plugin
> prototype (iterations 1–3, eight test subagents, full trajectory audit retained). Runtime facts
> are cross-checked against community references (dsh-anchored-standard / context-gate /
> @argszero/cordis-plugin-preset-tool-filter / @a9i5k4/dsh-anchored-monitor /
> @max-null/dsh-allostasis / we-need-ds) in the table below.

## Installation

**From GitHub (recommended):**

```powershell
dsh plugin add github:ggfgfgf-on/dsh-trajectory-anchor
```

`dsh plugin` is a pnpm forwarder: after installing, it detects the package's `dsh.bundle.patch`
declaration and joins it to the profile layer stack (`dsh.profile.bundles`) automatically — no
manual configuration. This package has no `prepare` script, so no pnpm `allowBuilds` entry is
required.

**Local `file:` dependency (offline / development):**

```powershell
# in the profile's package.json dependencies add:
#   "@dsh-ext/trajectory-anchor": "file:<path-to-this-repo>"
pnpm install

# and append one row to the profile's cordis.patch.yml (or let the bundle patch merge it):
#   - insert:
#       - id: trajectory-anchor
#         name: '@dsh-ext/trajectory-anchor'
```

Restart DSH. The plugin mounts on the host plane: it adopts all live agents at startup
(audit-only) and every new agent then goes through the
**anchor → gate promotion → continuous scoring** lifecycle.

## Lifecycle

```
agent/created
   │  restrict({ allow: visible bootstrap tools })     # probed against the agent scope
   │  complete persona("You are a helpful …")          # same-name override of the preset persona
   │  suppressRuntimeContext()                         # clear dynamic runtime-context
   ▼
request #1: bootstrap tools + Minimal persona (maxTokens uncapped by default)
   │  first tool/call → gate-armed
   ▼
gate wait: latest reasoning window looks minimal-like (positive markers hit, no negative
   │  markers — under the DS lexicon: contains "we", no "let me"; the gate follows whichever
   │  lexicon is active, so inverted-polarity bucket lexicons gate on their own markers)
   │  fallbacks: maxBootstrapSteps=5 / promoteAfterFirstResponse
   ▼
promotion: lift restrictions + restore context + explicitly strip the maxTokens cap
   │  (the seed would otherwise inherit the previous header)
   ▼
steady state: EWMA trajectory scoring + hysteresis state machine + (optional) drift
   │  rollback + counterfactual candidate mining
   ▼
agent/disposed: RewardAnnotator process reward + trajectory JSONL final archive
```

## Key configuration (cordis.patch.yml)

| Key | Default | Meaning |
|---|---|---|
| `bootstrapTools` | `[bash, str_replace_editor, pwsh]` | intersected with the tools the agent scope can actually see; on Windows the bash row is usually disabled |
| `bootstrapMaxTokens` | **`null` (uncapped)** | opt-in: capping the first response below its real size truncates the opening plan and kills the turn (community issue #85, reproduced locally); when enabled, the cap is explicitly stripped on promotion (seed-inheritance trap) |
| `gateEnabled` | `true` | anchorGate promotion gating |
| `maxBootstrapSteps` | `5` | gate fallback |
| `suppressContextOnBootstrap` | `true` | agent-scope context suppression during bootstrap |
| `lexicon` / `ratioWeights` | monitor-calibrated | weighted lexicon scoring (we/let's/we'll/"we need"/our vs "let me"; neutral i will/i'll/i need/check/verify) |
| `lexiconProfiles` | `{}` | optional name-hinted dictionaries (keyed by any model/provider name); candidates must still pass the output fit probe — names never override the output |
| `lexiconAuto` | enabled; probe at session start; floor 3 sessions / 40k chars, cap 160k, stability 0.6 | output fit probe → (mismatch only) sample → signature-matched style buckets → adaptive target → stability-gated calibrate → apply; see "Lexicon calibration" below |
| `specMax` / `reactMin` | `0.2` / `0.5` | persona_ratio band boundaries (spec/mixed/react) |
| `baselineMinSamples` / `rollbackPercentile` | `10` / `25` | **baseline-relative drift**: rollback only fires when the current ratio's percentile within the session's own history is < 25 |
| `rollbackEnabled` | `true` | calibrated rollback switch (safe to enable under baseline-relative semantics) |
| `leanDenyPatterns` | 61 entries | drift-rollback deny set (`*` prefix wildcards) |
| `rewardAnnotator` | `default` | Layer-4 process reward; pluggable extension point |

## Ablation guidance (calibration vs core)

For evaluators running ablations, these knobs are **calibration choices**, not core
behavior — documented defaults are intentional:

| Knob | Default | Role |
|---|---|---|
| `specMax` / `reactMin` | `0.2` / `0.5` | persona_ratio band boundaries (calibration) |
| `baselineMinSamples` | `10` | minimum session-history window before baseline scoring engages |
| `rollbackPercentile` | `25` | drift-rollback trigger: current ratio's percentile within the session's own history |
| `lexicon` / `ratioWeights` | monitor-calibrated | weighted lexicon scoring table |

Core behavior (anchoring, gating, context suppression, per-step trajectory export) does not
depend on these values; the absolute-vs-baseline-relative drift decision is itself a core
behavior that replaced an earlier absolute-band design (which misfired on models whose
natural baseline style is let-me).

## Calibration findings (measured, important)

1. **The anchoring effect holds on this deployment's model (deepseek-v4-flash)**: with only pwsh
   plus the Minimal persona (uncapped), the first reasoning block of a fresh subagent is pure "we"
   (lexicon ratio 282–290, spec band) — no 1024 cap needed. Consistent with the community
   "Minimal schema at 256000 anchors 5/5" result.
2. **The 1024 first-round cap is a risk, not an anchoring requirement**: truncating the opening
   plan makes the subagent die with zero tool calls (issue #85 reproduced locally), so it is off
   by default.
3. **Absolute bands do not detect drift**: deepseek-v4's baseline style is let-me (react band),
   so the old binary scoring always flagged drift. After upgrading to lexicon + bands +
   **session-own baseline percentiles**, "drift" means degradation relative to the agent's own
   history (the ratio 290→1 drop after promotion is exactly that signal), and rollback no longer
   fires unconditionally.
4. The runtime agent identifier field is `id` (not `sessionId`); trajectory files must live under
   the process-level workspaceRoot (the sandbox-policy-allowed area).
5. Perception channels: `internal/dispatch` (unfiltered, fires before every dispatch) plus direct
   waterfalls (`agent/request` / `agent/pre-step` registered with `prepend: true`). Host-plane rows
   are reachable — verified live.
6. **Anchor issuer principle**: anchors and scores are only meaningful when issued by a party
   outside the measured subject. Here the lexicon scores, band/percentile state, and process
   reward are all computed by the host-side audit plane (this plugin); the agent only produces
   artifacts. Anchor credibility comes from the issuer, not the anchor count.

## Community reference mapping

| Mechanism | Reference |
|---|---|
| explicit maxTokens strip after promotion, prepend registration discipline | dsh-anchored-standard `shared/tool-bootstrap.mjs` |
| pre-step filter await-next + claimed baseline + failure degradation | dsh-anchored-standard `shared/context-gate.mjs` |
| restrict visible-surface pre-filter + run_code exclusion | `@argszero/cordis-plugin-preset-tool-filter` |
| lexicon/band/percentile scoring, L1 hint wording, L2 re-anchoring payload | `@a9i5k4/dsh-anchored-monitor` |
| recency-position bias correction + per-round throttling | `@max-null/dsh-allostasis` |
| decision-round / execution-round decoupling | `we-need-ds` |

## Lexicon calibration (output-fingerprinted style buckets, automatic)

The default lexicon (we/let's/"we need"/our vs "let me") is calibrated on DeepSeek-style
reasoning; other outputs need their own marker words. The plugin handles this **without any
manual steps**, and — crucially — **names never decide anything**: model/provider strings are
aliases and gateway labels that drift over time (`ark-code-latest` may point to a different
model tomorrow), so recognition, selection, accumulation and merging are all driven by the
**output text itself**. Names are recorded as human-readable labels only.

1. **Probe fit at session start** — pure passive observation, never a test: the plugin *reads*
   the first few natural reasoning blocks the model already produced (post-lift for anchored
   sessions — the bootstrap phase is persona-primed, not the model's own style) and scores them
   against every candidate lexicon: the default DS lexicon, all calibrated style buckets, and
   any name-hinted profiles. Fit = **marker hit rate** (do the lexicon's terms appear at all?)
   + **ratio spread** (can the lexicon separate planning-style from reactive-style blocks?)
   + **bootstrap polarity** (does the candidate score the known-good anchored bootstrap phase
   positive-dominant?). The best-fitting candidate wins; the output alone decides. Nothing is
   injected, no prompt is added, and the model never sees the probe or its scores — the probe
   only changes which lexicon computes the host-side audit score.
   - Fits (e.g. DS lexicon on DeepSeek-style output: hit rate ≈1, ratio CV ≈0.8) → keep using
     it, nothing else happens.
   - Nothing fits (e.g. DS lexicon on Doubao-style Chinese reasoning: hit rate ≈0) →
     `lexicon-mismatch` is logged and the auto-calibration flow below kicks in.
   - **Polarity inversion** is caught, not ignored: a model whose *anchored* style is "let me"
     (like Doubao — it writes let-me even during the anchored bootstrap) would score
     negative-dominant under the DS lexicon, so the probe marks that candidate
     `polaritySuspect` and refuses it (`reason: polarity-inverted`), even though the markers
     all hit. Auto-calibration then rebuilds polarity from the bootstrap oracle (step 2/4).
2. **Sample** — only for mismatched output, the plugin quietly accumulates style samples:
   reasoning text + the session's own baseline percentile (a model-agnostic quality signal —
   not DS-lexicon scores, so no circular bias). Samples taken during the anchored bootstrap
   phase are tagged `anchored: true` — the **polarity oracle**.
3. **Match by style signature** — at session close, the session's own contrast terms
   (high-percentile vs low-percentile n-grams) form its style signature, which is matched
   against every bucket's signature (term-set Jaccard ≥ `bucketMatchThreshold`, default 0.25).
   Same style → merge into that bucket; new style → a new bucket. Consequences, all verified
   on synthetic corpora: same-style sessions merge (Jaccard ≈1), cross-style sessions split
   (Jaccard ≈0); a model that silently changes style under the same name opens a new bucket
   instead of poisoning the old one.
4. **Calibrate** — "how much corpus is enough" is not a fixed number and not "the more the
   better"; it is decided per bucket in three steps:
   - **Polarity labeling (oracle first)**: when the bucket has ≥10 anchored-bootstrap samples
     and ≥10 post-lift samples, the contrast is computed as *bootstrap (known-good) vs post-lift
     (natural output)* — this fixes polarity automatically for models whose anchored style is
     "let me" (Doubao-style) without inheriting the DS lexicon's polarity. Only without an
     oracle (unanchored / self sessions) does labeling fall back to session-own percentiles.
     Verified on synthetic corpora in both directions: let-me-anchored models get let-me
     positive; we-anchored models get we positive. The n-gram engine is script-generic
     (CJK ideographs incl. ext-A, kana, Hangul, Latin incl. diacritics, Cyrillic — verified
     auto-discovering oracle markers in Chinese, Japanese, Korean and French synthetic
     corpora); scripts outside this coverage (e.g. pure Arabic) are an honest boundary.
     The oracle premise is sanity-checked per session (`oracle-unvalidated` audit): if the
     model's bootstrap phase is systematically shallower than its post-lift output (fewer
     reasoning blocks per message — an independent, lexicon-free structural signal), the
     oracle is refused for that model and percentile labels are used instead. A second,
     outcome-side check compares operational error rates (non-zero exit codes / sandbox
     denials / structured ok:false|error fields) of bootstrap-phase vs post-lift tool calls —
     an anchored phase that behaves operationally worse than natural output fails the premise.
     These are premise checks on sparse real signals, not full per-block quality validation —
     output *quality* validation would need task scores (available in benchmark runs like
     Project2, absent in general sessions). v0.6.8 adds the general-session quality proxy:
     reasoning blocks are linked to the outcomes of the tool calls issued in the same
     turn/step (exit codes / sandbox denials / structured ok:false), and a freshly calibrated
     lexicon is only published if its positive-marked blocks carry a LOWER downstream error
     rate than its negative-marked blocks (`lexicon-outcome-inverted` refuses publication
     otherwise). Attribution is noisy (a step can hold several tool calls; failures are not
     always the block's fault) — it validates polarity against real outcomes, not output
     quality itself.
   - **Low-frequency markers**: terms with total frequency below `minFreq` are only admitted
     when they pass a two-sided Fisher exact test (p<0.05) on the 2×2 frequency table —
     "1 hit in anchored, 0 in drifted" artifacts are rejected (p≈0.5), while genuinely rare
     discriminative markers (≈6 single-side hits on a 3k-char side) are admitted. At the
     designed corpus scale (40k+ chars) even ≈0.1‰ markers accumulate enough hits, so thin
     corpora no longer gate discovery.
   - **Floor** (`minSessions` + `minChars`): enough sessions/tasks that task vocabulary cannot
     dominate the contrast (the known single-session contamination trap).
   - **Adaptive target**: the char target scales with the bucket's own n-gram concentration —
     concentrated style markers (like ark's 终验/终验证) converge fast, so the target shrinks
     toward `minChars`; diffuse vocabulary gets up to 1.5× more text (formula below).
   - **Stability acceptance**: at the target the plugin runs the shared contrast engine
     (`tools/lexicon-core.mjs`, log-odds n-gram contrast) on two random split-halves of the
     samples and compares the resulting dictionaries (term-set Jaccard + weight agreement).
     Only when the halves agree (`minStability`, default 0.6) is the corpus declared
     *converged*; otherwise the target auto-grows ×1.5 and sampling continues — up to the
     `maxChars` cap, after which every new session re-tests stability. Measured on synthetic
     corpora: thin (10+10) splits agree at ~0.6, thick (200+200) at ~0.9 — the gate fires where
     it should.
5. **Apply** — the derived lexicon is attached to its bucket and persisted to
   `<logDir>/lexicon-state.json` (survives restarts; buckets keep accumulating). From then on
   the bucket is a candidate in step 1 and any session whose output fits it uses it
   automatically.

Adaptive target formula: `target = minChars × (1 + (1 − C) × concentrationScale)`, clamped to
`[minChars, maxChars]`, where `C` = frequency share of the top-50 n-grams (vocabulary
concentration). Defaults: 3 sessions / 40k chars floor, 160k cap, scale 0.5, stability 0.6.

Auto-calibration knobs (all under `lexiconAuto`, patchable in cordis.patch.yml): `enabled`
(default `true`), fit probe (`probeMaxBlocks` 8 / `probeMinChars` 2500 / `probeMinBlocks` 4 /
`probeMinHitRate` 0.25 / `probeMinSignalBlocks` 3 / `probeMinRatioSpread` 0.15). When the probe
window fills with too few marker hits (early blocks can be marker-poor text — e.g. Chinese-heavy
reasoning), the window auto-widens up to 2 times (3× the base caps, audited as
`lexicon-probe-extend`) instead of deciding on thin evidence — a one-shot early sample once
misjudged a DeepSeek session as "unreadable" whose later output was full of markers,
`polarityMinBootstrapBlocks` (3), `bucketMatchThreshold` (0.25), `minSessions` (3), `minChars` (40000), `maxChars` (160000),
`concentrationScale` (0.5), `minStability` (0.6), `percentileHigh` / `percentileLow` (75/25),
`minFreq` (5), `top` (60). Progress is audited (`lexicon-names` / `lexicon-fit` /
`lexicon-mismatch` / `lexicon-probe-extend` / `lexicon-auto-progress` / `lexicon-auto-target` /
`lexicon-auto-pending` / `lexicon-calibrated` events) and visible in the `anchor_status` tool's
`lexicon` block (style buckets with names, calibration state, target chars, concentration, last
split-half
stability).

**Pre-seed a known dictionary** (optional, name-hinted) via `lexiconProfiles` in the patch —
the candidate is still validated against the actual output and dropped if it does not fit:

```yaml
config:
  lexiconProfiles:
    ark-code-latest: { positive: { '终验': 2 }, negative: {}, neutral: {} }
```

**Manual CLI calibration** (research / one-off corpora) still works, now sharing the same
contrast core as the runtime:

```powershell
node tools\calibrate-lexicon.mjs `
  --corpus <dir-with-model-session-logs> `        # reads DSH session.jsonl.zstd directly
  --reference-corpus <dir-with-ds-session-logs> ` # cross-corpus frequency ratio
  --name ark-doubao --out .\lexicon-ark
```

- Output: `<out>.json` (auto-labeled positive/negative/neutral with suggested weights) +
  `<out>-report.md` (frequency / ratio / example sentences).
- Honest boundary: statistics find the model's marker words; polarity (planning-style vs
  reactive-style) is a semantic judgment. The plugin-side auto path sidesteps it by labeling
  with the session-own percentile (planning-style = high percentile, reactive = low), which is
  model-agnostic and needs no human review. Corpus size drives quality: a single short session
  surfaces mostly task vocabulary; style markers (e.g. ark's 终验/终验证 abbreviation, ~197x
  over the DS corpus) appear once enough reasoning text accumulates.

**Score-supervised calibration** (advanced users, connects to Layer 4) —
`tools/calibrate-from-scores.mjs` uses real benchmark scores as supervision, closing the loop
"run Project2-like tasks → scores label sessions → lexicon + scorer". Two modes:

*General labels mode* (any corpus, any task, any overall score):

```powershell
# labels.json 形式 A：自选任务、自给总分
#   [ { "corpus": "路径", "score": 100 }, { "corpus": "路径", "score": 86 } ]
# labels.json 形式 B：直接给正/负两组语料
#   { "positive": ["路径", ...], "negative": ["路径", ...] }
# corpus 路径：目录（.txt/.md/.jsonl/.zstd 递归）或单文件（含 DSH session.jsonl.zstd）
node tools\calibrate-from-scores.mjs --labels .\labels.json --high 95 --low 90 --out .\lexicon-score
```

*Project2 auto mode* (scans evaluator results and matches candidate sessions):

```powershell
node tools\calibrate-from-scores.mjs `
  --results D:\DSHwork\modeltest\evaluator\results `   # each run's score_draft.json
  --sessions C:\Users\chesand\.dsh\sessions `          # candidate session logs
  --model ark-code-latest --run-group ark_dsh_trajectory_anchor `
  --high 95 --low 90 --out .\lexicon-score
```

- High-score sessions (≥`--high`) form the anchored corpus, low-score (≤`--low`) the drifted
  corpus; contrast polarity is decided by the scores themselves — no human review.
- The same data grid-fits `ratioWeights` (the scorer) to maximize block-ratio separation
  between high- and low-score corpora; both are reported and patch-ready.
- Sessions match runs by model + time window with greedy one-to-one assignment
  (`--run-group` narrows the run set, comma-separated for several groups; per-run evidence is
  in the report).
- **Anti-mixing is opt-in, not baked-in policy**: different tasks have different candidate
  protocols, so the tool assumes nothing by default. `--exclude-orchestrator` skips sessions
  that called `subagent`/`workflow`/`ralph`/`send_message` tools (orchestrator/parent
  sessions — useful when your candidate protocol forbids those), and
  `--max-duration-hours N` skips sessions longer than N hours (everyday chats). `--model`
  filters by the session's own request/header labels. Whatever the settings, the evidence
  table is the real control — check every row shows the intended model and a sensible
  text-block count (a 47M-char orchestration session once polluted a corpus because it
  shared the model name; the guards were born from that incident but must stay opt-in).
- **One session per eval round** is required for clean labels: a single session that spans
  several eval rounds (first pass + repairs in one session) carries several scores and cannot
  be labeled; the evidence table exposes such rows (same session against different runs).
- Layer-4 connection: those sessions' `export-layer4` samples now carry true quality labels.
- Measured honest boundaries: benchmark scores are session-level (all blocks share one
  label — coarse); a single task's vocabulary competes with style markers (the first real run
  produced task-word-heavy candidates — the report's evidence table shows exactly why); if
  either corpus side drops below 10 blocks the tool refuses to calibrate instead of
  fabricating a lexicon. Accumulate runs across several different tasks for a clean style
  layer.
- First complete empirical run (v4-pro, 4 clean one-session-per-run rounds: 97/98/98/100):
  the pipeline matched 4/4 sessions with zero cross-model mixing; the calibrated lexicon
  raised block-ratio separation from 0.13 (built-in DS lexicon — nearly blind on that day's
  drifted v4-pro output, hit rate 0.28) to 0.42 — but the terms were pure task vocabulary
  (positive: 占位符/模板措辞/BOM from the template-fix session; negative: ts/events/care
  from the defect sessions). Verdict recorded as designed: single-task data must NOT feed
  the built-in lexicon; the auto-bucket machinery remains the style-layer channel, and
  score-supervised optimization needs several different benchmark tasks before its output
  can replace the built-in. Use `tools/compare-lexicons.mjs` for the old-vs-new separation
  test on any corpus pair.

## Layer-4 training-data export

`tools/export-layer4.mjs` joins the trajectory JSONLs (event stream + process reward) with the
DSH session logs (text) into step-level training samples — zero dependencies, Node ≥ 22
(`node:zlib` decodes zstd):

```powershell
node tools\export-layer4.mjs `
  --logs-dir <workspaceRoot>\.dsh-trajectory-logs `
  --sessions-dir $env:USERPROFILE\.dsh\sessions `
  --out D:\datasets\layer4-1
```

- **Aggregate**: assistant-message/tool-call events are aligned to session-log text by
  `(turn, step)`; the nearest lexicon score is attached
- **Clean**: closed agents only; main-session traces (`anchor-session-*` / `summary.self`)
  excluded; lifecycle marker lines dropped; grouped per session
- **Schema**: `{sessionId, model, turn, step, kind, messages, response, toolName, toolResult,
  execution{id, trajectory_occurrences, session_occurrences, cross_plane, ambiguous},
  reward{lexicon, sessionScore, scoreNorm, planner}, trajectory_features{…}, textComplete}` —
  compatible with PRM (per-step process reward) and DPO/RLVR (pairwise sampling per sessionId)
- **Execution identity**: every sample carries an execution id (`<sessionId>#<turn>:<step>`) plus
  cross-plane evidence (`trajectory_occurrences` = trajectory block lines, `session_occurrences` =
  session-log message fragments). DSH session logs split one message into several fragments that
  share the same `(turn, step)` — the exporter merges them into the full text instead of treating
  multi-fragment steps as ambiguity (a naive uniqueness check silently dropped ~12% of good text;
  measured and fixed). `stats.json` reports `execution_stats` (verified / one-sided) per run.
- **Normalize**: min-max normalization of session rewards (`scoreNorm`), positive/negative
  lexicon-polarity counts, band/liftReason/machineState buckets
- Output: `dataset.jsonl` + `stats.json` (inclusion/exclusion list, text coverage, model
  distribution) + `manifest.json`

## Verification

- Per-agent trajectory audit: `<workspaceRoot>/.dsh-trajectory-logs/anchor-<agentId>.jsonl`
  plus append-only chunk files `anchor-<agentId>.jsonl.<n>` (the buffer drains to an
  immutable chunk when it crosses the event-count or byte-budget threshold —
  `auditChunkEvents` / `auditChunkBytes` — so long runs lose no events)
- Live state: the `anchor_status` tool (globally registered, read-only)
- Event-sequence assertion: `adopted → anchored → context-suppressed → maxTokens-rewrite →
  gate-armed → lift(anchor-gate:minimal-like | max-steps) → context-restored →
  maxTokens-strip → score… → closed + record(incl. reward)`

## License

MIT.
