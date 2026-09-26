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
- **Execution guard**: every sample carries an execution id (`<sessionId>#<turn>:<step>`) plus a
  cross-plane uniqueness check — when the session plane contains the same `(turn, step)` more than
  once (retry / torn append), the join is marked `ambiguous` and refuses to attach text instead of
  silently pairing two different executions. `stats.json` reports `execution_stats` (verified /
  ambiguous / one-sided) per export run.
- **Normalize**: min-max normalization of session rewards (`scoreNorm`), positive/negative
  lexicon-polarity counts, band/liftReason/machineState buckets
- Output: `dataset.jsonl` + `stats.json` (inclusion/exclusion list, text coverage, model
  distribution) + `manifest.json`

## Verification

- Per-agent trajectory audit: `<workspaceRoot>/.dsh-trajectory-logs/anchor-<agentId>.jsonl`
- Live state: the `anchor_status` tool (globally registered, read-only)
- Event-sequence assertion: `adopted → anchored → context-suppressed → maxTokens-rewrite →
  gate-armed → lift(anchor-gate:minimal-like | max-steps) → context-restored →
  maxTokens-strip → score… → closed + record(incl. reward)`

## License

MIT.
