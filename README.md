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

## 快速开始（普通用户）

装完即用，零手动配置：`dsh plugin add github:ggfgfgf-on/dsh-trajectory-anchor` 之后重启 DSH 即可。

- **每个模型独立判断**（按模型名，不是供应商——同一供应商会代售多个厂商的模型）：
  每个会话开头插件先用默认 DS 词典，并自动探测**这个词典读不读得懂该模型**——
  读得懂就一直用，什么都不发生；读不懂（标记命中率低 / 比率分不开）才在后台攒样本，
  攒够后**自动生成该模型的专属词典并立即生效**，之后所有会话自动沿用
  （跨重启持久化，无需任何操作）。
- **看状态**：随时调用 `anchor_status` 工具，`lexicon` 块里有每个模型的
  拟合探测结果与标定进度。

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
gate wait: latest reasoning window looks minimal-like (contains "we", no "let me")
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
| `lexiconProfiles` | `{}` | per-model built-in dictionaries, keyed by model name (not provider); pre-seed a known model to skip the auto-calibration wait |
| `lexiconAuto` | enabled; probe at session start; floor 3 sessions / 40k chars, cap 160k, stability 0.6 | fit probe → (mismatch only) sample → adaptive target → stability-gated calibrate → apply; see "Lexicon calibration" below |
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

## Lexicon calibration (per-model dictionaries, automatic)

The default lexicon (we/let's/"we need"/our vs "let me") is calibrated on DeepSeek-style
reasoning; other models need their own marker words. The plugin handles this **without any
manual steps**:

1. **Detect** — every session reports its model name (request/header events), so the plugin
   knows which *model* is talking. Dictionaries are keyed by model name, never by provider:
   one provider (e.g. Huoshan/Volcano) resells many vendors' models, and their styles cannot
   share a lexicon. The provider is only used as a fallback identifier when the model name is
   missing.
2. **Resolve** — per-model dictionaries resolve in order: auto-calibrated override >
   built-in profile (`lexiconProfiles`, keyed by model name) > default DS lexicon.
3. **Probe fit at session start** — before doing anything, the plugin checks whether the
   active lexicon can actually read this model: it scores the first few natural reasoning
   blocks (post-lift for anchored sessions — the bootstrap phase is persona-primed, not the
   model's own style) and measures **marker hit rate** (do the lexicon's terms appear at all?)
   plus **ratio spread** (can the lexicon separate planning-style from reactive-style blocks?).
   - Fits (e.g. DS lexicon on a DeepSeek model: hit rate ≈1, ratio CV ≈0.8) → keep using it,
     nothing else happens.
   - Does not fit (e.g. DS lexicon on Doubao-style Chinese reasoning: hit rate ≈0) →
     `lexicon-mismatch` is logged and the auto-calibration flow below kicks in.
4. **Sample** — only for a mismatched model, the plugin quietly accumulates style samples:
   reasoning text + the session's own baseline percentile (a model-agnostic quality signal —
   not DS-lexicon scores, so no circular bias).
5. **Calibrate** — "how much corpus is enough" is not a fixed number and not "the more the
   better"; it is decided per model in three steps:
   - **Floor** (`minSessions` + `minChars`): enough sessions/tasks that task vocabulary cannot
     dominate the contrast (the known single-session contamination trap).
   - **Adaptive target**: the char target scales with the model's own n-gram concentration —
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
6. **Apply** — the derived lexicon is active immediately for that model and persisted to
   `<logDir>/lexicon-state.json` (survives restarts; the ledger keeps accumulating).

Adaptive target formula: `target = minChars × (1 + (1 − C) × concentrationScale)`, clamped to
`[minChars, maxChars]`, where `C` = frequency share of the top-50 n-grams (vocabulary
concentration). Defaults: 3 sessions / 40k chars floor, 160k cap, scale 0.5, stability 0.6.

Auto-calibration knobs (all under `lexiconAuto`, patchable in cordis.patch.yml): `enabled`
(default `true`), fit probe (`probeMaxBlocks` 8 / `probeMinChars` 2500 / `probeMinBlocks` 3 /
`probeMinHitRate` 0.25 / `probeMinSignalBlocks` 3 / `probeMinRatioSpread` 0.15), `minSessions`
(3), `minChars` (40000), `maxChars` (160000), `concentrationScale` (0.5), `minStability`
(0.6), `percentileHigh` / `percentileLow` (75/25), `minFreq` (5), `top` (60). Progress is
audited per model (`lexicon-resolved` / `lexicon-fit` / `lexicon-mismatch` /
`lexicon-auto-progress` / `lexicon-auto-target` / `lexicon-auto-pending` /
`lexicon-calibrated` events) and visible in the `anchor_status` tool's `lexicon` block
(target chars, concentration, last split-half stability per model).

**Pre-seed a known dictionary** (skip the probe waiting period) via `lexiconProfiles` in the
patch — keyed by model name:

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
