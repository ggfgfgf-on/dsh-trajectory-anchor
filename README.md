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
| `specMax` / `reactMin` | `0.2` / `0.5` | persona_ratio band boundaries (spec/mixed/react) |
| `refMinSteps` / `testWindow` | `12` / `4` | **session-local reference test**: the last `testWindow` observations are compared against the session's own earlier history |
| `actAlpha` / `notifyAlpha` | `0.01` / `0.05` | budgets for the capability layer / notification layer (one-sided Mann-Whitney p-value thresholds) |
| `maxDriftSteps` | `12` | hard bound on any narrowed episode — the exit condition that is **provably reachable** |
| `rollbackEnabled` / `notifyEnabled` | **`false` / `false`** | capability / notification switches. Both default OFF (observe-only) because the calibration measured the lexicon signal's session-level false-trigger rate at 15.9% (α=0.001) / 43.2% (α=0.01) — far above a 5% budget. See "Response policy" below |
| `leanDenyPatterns` | 28 entries | the set hidden while `surfacePhase === 'narrowed'` (`*` prefix wildcards); count is asserted against the source by `tools/check-invariants.mjs` |
| `rewardAnnotator` | `default` | Layer-4 process reward; pluggable extension point |

## Response policy (P1–P7): derived tool surface, bounded episodes

**The tool surface is derived at assembly time, never mutated in the registry.**
A `system-prompt/assemble` handler filters `assembly.tools` by the current
`surfacePhase` (`surfaceForPhase()`, a pure function). Two consequences:

- **No "restore" step exists.** When the phase returns to `stable`, the *next*
  assembly is the full catalog. The class of bug that plagued this plugin — a
  restriction granted through `tools.restrict({deny})` whose only release path
  (`band === 'spec'`) was unreachable — is structurally impossible now.
  (Measured before the change: 23 sessions entered rollback, **0** ever
  recovered; 18 sessions were permanently stuck at 23 tools and later calls
  failed with `unknown tool`.)
- **Fail-open.** Any exception inside the filter returns the original assembly
  (`surface filter failed, exposing the full catalog`), and every bootstrap
  degradation writes an `anchor-degraded` audit event plus a one-shot warning —
  the plugin's own bug must never eat the user's capability.

**Drift detection is a session-local reference test, not a fixed threshold.**
The retired trigger was `percentile < 25` on a single step — a *definitional*
rank (a bottom-quartile cut always contains ~25% of steps), whose measured
per-session false rate ranged 4.3%–92.1% across 25 sessions (21× spread, lag-1
autocorrelation 0.65). The replacement compares the last `testWindow`
observations against the session's own earlier history with a one-sided
Mann-Whitney test, so the budget lives *inside* the session and no global
`(K, k)` pair is needed at all.

**Effective warm-up is `testWindow + refMinSteps` = 16 steps (defaults).** The
p-value needs a reference segment *outside* the test window
(`refLen = history − testWindow ≥ refMinSteps`), so the first real decision can
only land on step 16. The warm-up splits into two tiers; both are inert
(`level=stable`, `action=none`) and both are written to the trajectory log as
`policy-skipped`, so "why didn't the decision start?" is always answerable:

| Tier | Condition | `policyReason` |
|---|---|---|
| no test window yet | `history < testWindow` (steps 1–4) | `no-observation` |
| reference too short | `testWindow ≤ history < testWindow + refMinSteps` (steps 5–15) | `insufficient-reference` |

**Every narrowed episode is bounded** by `maxDriftSteps` (exit condition
provably reachable), and exhausting the capability budget blocks further
narrowing until the episode genuinely ends.

**Switches default OFF because the calibration says so.**
`tools/calibrate-response-policy.mjs` replays the historical corpus through the
runtime's own pure functions (`mannWhitneyLowerP`, `policyDecision`):

| α | sessions falsely narrowed | worst-session narrowed-step share |
|---|---|---|
| 0.001 | 7/44 = 15.9% | 40.0% |
| 0.01 | 19/44 = 43.2% | 43.3% |
| 0.05 | 23/44 = 52.3% | 40.2% |

Verdict: **FAIL — the lexicon signal cannot support capability-layer action.**
Hence `rollbackEnabled=false` and `notifyEnabled=false` ship as defaults; the
plugin observes and audits until a signal passes the budget (or a behavioural
signal replaces the lexical one).

`tools/replay-interventions.mjs` verifies the invariants that remain ours to
keep: no episode exceeds the bound, no episode ends for an unexpected reason,
and replaying the same series twice yields identical decisions.


## Ablation guidance (calibration vs core)

For evaluators running ablations, these knobs are **calibration choices**, not core
behavior — documented defaults are intentional:

| Knob | Default | Role |
|---|---|---|
| `specMax` / `reactMin` | `0.2` / `0.5` | persona_ratio band boundaries (calibration) |
| `refMinSteps` / `testWindow` | `12` / `4` | session-local reference-test sizes |
| `actAlpha` / `notifyAlpha` | `0.01` / `0.05` | capability / notification budgets (calibration) |
| `lexicon` / `ratioWeights` | monitor-calibrated | weighted lexicon scoring table |

Core behavior (anchoring, gating, context suppression, per-step trajectory export, derived
tool surface, bounded episodes) does not depend on these values. The drift decision itself is a
core behavior that has been redesigned twice: absolute bands → baseline-relative percentile
(v0.4.x) → **session-local reference test** (this version). Each redesign was driven by a
measurement, and the measurements are recorded below.

## Calibration findings (measured, important)

1. **The anchoring effect holds on this deployment's model (deepseek-v4-flash)**: with only pwsh
   plus the Minimal persona (uncapped), the first reasoning block of a fresh subagent is pure "we"
   (lexicon ratio 282–290, spec band) — no 1024 cap needed. Consistent with the community
   "Minimal schema at 256000 anchors 5/5" result.
2. **The 1024 first-round cap is a risk, not an anchoring requirement**: truncating the opening
   plan makes the subagent die with zero tool calls (issue #85 reproduced locally), so it is off
   by default.
3. **Absolute bands do not detect drift** — and neither did the percentile replacement:
   deepseek-v4's baseline style is let-me (react band), so the old binary scoring always flagged
   drift. v0.4.x replaced it with lexicon + bands + **session-own baseline percentiles**; that
   fixed the absolute misfire but introduced a *definitional* trigger (a bottom-quartile cut
   always contains ~25% of steps, so its marginal rate is set by the threshold, not by the
   model). Measured across 25 sessions: per-session false rate 4.3%–92.1%, lag-1 autocorrelation
   0.65, mean degraded run 4.27 steps, and window rules could not be tuned below an 8–16%
   session-level floor. The current version therefore tests the last `testWindow` observations
   against the session's own earlier history (one-sided Mann-Whitney) and keeps capability
   changes switched off until the calibration passes.
4. **The runtime agent identifier field is `id` (not `sessionId`)**; trajectory files must live under
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
