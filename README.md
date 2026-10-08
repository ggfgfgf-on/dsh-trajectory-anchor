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

## What you get on install (zero configuration)

The bundle patch shipped with this package inserts the row with **no `config:` block**,
so a fresh install inherits the code defaults and cannot drift out of sync with them
(asserted by `tools/check-invariants.mjs` C12).

**Active by default — the performance lever:**

| Mechanism | Default | What it does |
|---|---|---|
| first-round anchoring | `bootstrapTools: [bash, str_replace_editor, pwsh]`, `bootstrapPersona` (Minimal), `suppressRuntimeContext()`, `suppressSkillCatalog` | keeps request #1 on the Minimal tool schema + Minimal persona — the condition under which anchoring reproduces |
| promotion gate | `gateEnabled`, `maxBootstrapSteps: 5`, `promoteAfterFirstResponse` | lifts the bootstrap restrictions and restores context; three independent fallbacks so a session can never be trapped in bootstrap |
| maxTokens handling | `bootstrapMaxTokens: null` (uncapped) | opt-in only: a cap below the real first-round output truncates the opening plan (issue #85); when enabled it is explicitly stripped after promotion |
| per-step trajectory scoring + audit log | `exportTrajectoryLogs`, `logDir` | `<workspaceRoot>/.dsh-trajectory-logs/anchor-<agentId>.jsonl`, append-only, chunked |
| `anchor_status` | read-only tool | live state, lexicon source, policy decision, audit tail |

**Off by default — the repair layer (deliberately):**

| Switch | Default | Why it is off |
|---|---|---|
| `rollbackEnabled` | `false` | narrowing the tool surface is the only capability-affecting action; it stays off until a calibration artifact passes the false-trigger budget |
| `notifyEnabled` | `false` | same signal, same budget — notifications are only useful once the signal discriminates |

Both are **safe off**: with them disabled the plugin observes and audits only, and no
code path can remove a tool from the registry (asserted by C3, and enumerated: with
both switches off `policyDecision` can only return `action: 'none'`).

Turning them on is not enough either, by design: the capability layer additionally
needs a passing calibration artifact, is suspended outright under
`measurementSafe` (so a measured score is never attributable to the plugin), and
demotes **itself** to observe-only if the live narrowed-session rate exceeds the
budget. See "Runtime gate (B3)" below.

## Version lineage

`package.json` is the single source of truth: **0.5.0** = B1 behavioural channels +
B2 budget-derived calibration + B3 runtime gate. Earlier commits described B1/B2 in
their messages as 0.4.8/0.4.9 while `package.json` still said 0.4.7 — a silent drift
of exactly the kind this project hunts, so the numbering was reconciled here and each
later change must bump `package.json` in the same commit.

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
| `responseChannels` | 4 channels, all `capabilityEligible: false` | per-channel overrides (`refMinSteps`, `testWindow`, `window`, `minRepeats`, `consecutive`, `capabilityEligible`). Merged **per channel** — overriding one channel never wipes the others |
| `actAlpha` / `notifyAlpha` | `0.01` / `0.05` | budgets for the capability layer / notification layer (one-sided Mann-Whitney p-value thresholds for the lexicon channel; exact one-sided binomial for the behavioural channels) |
| `responsePolicyPath` | `null` | calibration artifact (`responsePolicy.json`) that decides which channels may act; `TRAJECTORY_ANCHOR_POLICY_PATH` is an equivalent source. Missing / unparseable / expired / `verdict ≠ PASS` ⇒ observe-only |
| `measurementSafe` | `false` | evaluation protection: `true` forces observe-only (both layers), so a measured score cannot be attributed to the plugin |
| `autoDemoteWindow` / `autoDemoteBudget` | `20` / `0.05` | online self-check: if more than `autoDemoteBudget` of the last `autoDemoteWindow` finished sessions narrowed, the plugin demotes **itself** to observe-only and writes an `auto-demote` audit event |
| `maxDriftSteps` | `12` | hard bound on any narrowed episode — the exit condition that is **provably reachable**. Derived, not guessed: replaying 45 sessions / 3,299 steps with the bound off gives natural episode lengths p50=5, p75=9, **p90=12**, p95=19, max=22, so 12 = the p90 of what an episode naturally lasts (it truncates 5 of 53 episodes). The value is a *safety bound*; the real budget lever is the false-trigger rate (G1 gate). A calibration artifact may recompute and override it by the same quantile method |
| `rollbackEnabled` / `notifyEnabled` | **`false` / `false`** | capability / notification switches. Both default OFF (observe-only) because the calibration measured the lexicon signal's session-level false-trigger rate at 15.9% (α=0.001) / 43.2% (α=0.01) — far above a 5% budget. See "Response policy" below |
| `pullbackEnabled` / `pullbackMaxPerSession` | **`false`** / `3` | the informational pull-back (L1): advisories near the point of action when an out-of-scope write or an unverified code change is detected. Off by default because its mechanism is verified while its *effect* is not measurable from this corpus (there is no labelable drift in it) |
| `reanchorEnabled` / `reanchorEvidencePath` | **`false`** / `null` | re-anchoring (L2): puts the first-round Minimal payload back near the point of action. Requires an online-evidence artifact (`verdict: PASS-online`, unexpired, non-synthetic) **and** that L1 already spoke; once per session |
| `pullbackOutcomePath` | `null` (defaults under the audit dir) | where the per-session pull-back outcome JSONL goes — the input `analyze-pullback-outcomes.mjs` needs before the L2 gate can ever open |
| `familyPriorPath` / `priorStrength` | `null` / `20` | L3 family-prior shrinkage: point at `familyPriors.json` (per-`provider/model` base rates) and the channel tests estimate the null rate from *both* the family prior and this session's own reference (`pHat = (refHits + rate·S) / (refLen + S)`). Unset / unreadable / unknown family ⇒ falls back to the fixed Jeffreys pseudo-count |
| `outcomeFeedbackEnabled` (+ `feedbackMinSessions`, `feedbackMinProductiveRate`, `feedbackRevokeEligibilityRate`, `feedbackAlphaFloorDivisor`, `feedbackExploreAfterSessions`) | **`false`** / `5` / `0.6` / `0.2` / `64` / `30` | L3 outcome feedback, **per channel**: honest outcomes tighten that channel's threshold (×0.5, floored), excellent outcomes relax it back toward the calibrated value (never past it), a very poor record revokes that channel's eligibility — plus an exploration step back up after a long quiet period, because tightening until a channel stops firing also cuts off its own evidence |
| `measurementSafe` | `false` | evaluation protection: `true` forces observe-only (both layers), so a measured score cannot be attributed to the plugin |
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

**Channels (B1).** Drift is now decided by several independent channels, each
tested against *the session's own* history (no global thresholds). Entry is an
**OR** — one channel firing is enough; a channel that is not capability-eligible
can never block another that is:

| Channel | What it measures | Window / min reference | Capability-eligible | Evidence |
|---|---|---|---|---|
| `lexicon` | one-sided Mann-Whitney on the session's own weighted-ratio series | 4 / 12 | **no** | calibration FAIL: 42.2% of sessions falsely narrowed at α=0.01 |
| `inaction` (A′) | a step with **no tool call** that is *not* the last step of its turn. Double-judged: a later step in the same turn proves it was mid-turn; `turn/end` demotes it to a legal ending | 3 / 20 | yes | 67 no-tool steps measured: **100% were turn-final** — without the turn-end exclusion this channel is a 100% false positive |
| `repetition` (C) | same tool + normalized args ≥2 times within the last 5 steps | 3 / 20 | yes | 0/26 sessions fired (community precedent: allostasis `repetition.js`, `REPEAT_MIN_COUNT=3` + `CONSECUTIVE_STEPS=2`) |
| `failure` (B) | the step's tool result carries an explicit failure marker (6 markers; runtime and calibration tool must agree — invariant C8) | 3 / 20 | **no** (notify only) | 12/26 sessions fired at k=2 — far above the 5% budget |

`responseChannels.<name>.capabilityEligible` ships **false for every channel** and
is meant to be flipped by a calibration artifact; until then every channel is
audit-only. Channel windows are visible live in `anchor_status` (`channels` = the
snapshot used by the last decision, `channelWindows` = the live ledger window).

**Why the per-test α cannot be a round number (B2).** α is the false-alarm rate of
*one test*, but the budget is per *session* — and a session runs hundreds of tests,
so the family-wise rate is ≈ `1 − (1 − α)^N`. Measured on the full corpus
(77 sessions / 41,584 post-anchor steps, `tools/calibrate-channels.mjs`):

| Channel | sessions falsely fired at α=0.01, k=1 | derived from a 5% budget |
|---|---|---|
| `inaction` (A′) | 14.3% | **k=1, α=0.001** → 2.6% (k=3, α=0.005 → 3.9%) |
| `repetition` (C) | 31.2% | k=1, α=1e-5 → 0.0% (k=2, α=1e-4 → 3.9%) |
| `failure` (B) | 41.6% | notify-only by design |
| *negative control*: inaction **without** the turn-end exclusion | 26.0% | correctly judged **unfit** |

So the hand-picked `actAlpha: 0.01` was ~2 orders of magnitude too loose;
consecutive confirmations (k) are the second lever — the observation-unit
hysteresis the community uses too (allostasis `trackLoop(..., CONSECUTIVE_STEPS=2)`).
Every candidate (k, α) that fits the budget is written into the artifact as
`withinBudgetCandidates`, so once recall is measured the most sensitive
configuration can be picked **without re-sweeping**.

> ⚠ **These numbers were recomputed in 2026-10, and the earlier ones were wrong.**
> The offline core used to carry its own ledger-finalization rule, which counted a
> legal turn ending (no tool call, last step of the turn) as an A′ hit — while the
> runtime excludes exactly those. Result: **123 of 128 sessions had a different
> sequence, and the A′ hit rate was 0.16% (runtime) vs 8.10% (offline) — a factor
> of 51.** So the old α was derived for a channel the runtime does not implement;
> the give-away was that the G3 "negative control" (26.0%) looked nearly identical
> to the "real" channel (27.3%) — a control that agrees with the thing it is
> supposed to falsify is not a control. The ledger now has **one** implementation
> (`buildLedgerFromEvents`, exported by `index.js`) and two guards:
> `tools/test-ledger-parity.mjs` drives decoded **real events plus synthetic
> streams** through a real `apply()` and compares every decision point against the
> batch ledger, and `tools/test-ledger-semantics.mjs` pins the four finalization
> cases against hand-computed truth (invariant C15). Both were negative-tested:
> breaking the turn-end exclusion or the cross-turn rule makes them fail.

**Recall is now measured, and it says the signal does not discriminate.** Recall was
the missing half — a detector that never fires has a perfect false-alarm rate. Using
T4 (automatic *delayed labelling*: after-the-fact confirmations as anchors, steps
before them as positives) on 59 sessions / 1,587 independent anchors
(`tools/measure-recall.mjs`, labels via `tools/drift-label-core.mjs`):

| Channel | α=0.05, k=1 fires/session | recall@3 steps | precision | chance baseline |
|---|---|---|---|---|
| `inaction` (A′) | 3.00 | **0.8%** | 7.3% | 19.2% |
| `repetition` (C) | 18.54 | **4.3%** | 6.2% | 19.2% |
| `failure` (B) | 11.25 | 2.6% | 6.2% | 19.2% |

The loosest threshold already fires 18 times per session and still recovers 4.3% of
the confirmations — **and its precision (6.2%) is three times *below* the 19.2%
chance baseline**, i.e. the fires are placed worse than at random (a repeated
identical tool call is the signature of *normal iterative debugging*: run the test,
fix, run it again). So the problem is not the threshold and not the budget: this
signal has no discriminative power for confirmed degradation, and **no operating
point on it is usable**.

Two honesty caveats that bound the claim: (a) the anchors confirm *failure*, not
"off-task" — a failing test is normal work — so the measured quantity is "does it
predict imminent confirmed failure"; (b) anchors are dominated by `tool-error`
(1,317 of 1,587).

**Task-anchored signals (L0-e) — the drift kind that has ground truth.** Since the
statistical channels were rejected, the next signals come from constraints written
into the prompt itself ("Work only inside bugfix-a4", "工作区仅限 … 目录 … 不要读取、
搜索或依赖 workspace 外", "Report ONE line: PASS=<n>/7"), which makes
*out-of-scope writes* and *unverified completion claims* facts rather than
probabilities (`tools/task-anchor-core.mjs`, 55 cases, and
`tools/measure-task-signal.mjs`). The parser **never guesses**: if no scope clause
can be read it returns `parsed: false` and emits nothing.

Measured on 42 sessions whose prompts are parseable:

| Label kind | v1 | after fixing false positives (v2) |
|---|---|---|
| out-of-scope write | 62 | **0** |
| out-of-scope read | 0 | 0 |
| unverified completion claim | 8 | **0** |

Both versions of the number are informative. v1's 62 "violations" were all false
positives — temp scripts (`AppData\Local\Temp`), virtualenv interpreters
(`.venv312\Scripts\python`), toolchains (`C:\Espressif\python_env`) and URL-shaped
tokens — because the scanner was reading paths out of shell *commands*; it now reads
only tool-argument path fields, ignores temp/venv/cache locations, and records what
it ignored. v1's 8 unverified claims were then **audited by hand: 0 of 8 were real**,
for four distinct reasons — a multi-command pipeline's `[exit code: 1]` next to
"all public tests passed"; `PASS=n/m` matching the *historical* value instead of the
last one; documentation-only edits (`.md`) being treated as invalidating prior
verification; and verification launched as a **background job**. All four are fixed
and pinned as regression fixtures, including the counter-case ("a *code* edit after
the last verification must still report") so the signal cannot be silenced into
uselessness. One deliberate refusal: "background job launched, result never polled"
is *not* labelled, because DSH delivers job results as messages — not polling does
not imply not consuming.

Result: **this corpus contains no labelable task-level drift at all.** That is the
honest state of the world, and it has a direct consequence for the intervention
work: the pull-back's *mechanism* can be verified (injected drift must fire it), but
its *efficacy* cannot be measured from this corpus — there is nothing to pull back.

### The pull-back itself (L1): near-term, advisory, throttled, off by default

`pullbackEnabled` (default **`false`**) adds the first action that speaks to the model
directly. It fires on the two signals that survived L0 — an out-of-scope **write**, and
a **code** edit that postdates the last verification — and it injects one independent
message at `agent/pre-step`:

- **Near-term position, not the prompt prefix.** Community reason (allostasis): a fixed
  prefix is the furthest thing from the output, and in long sessions the corrective
  signal is overrun by recency. Allostasis appends at `agent/pre-step` for this reason;
  so does this.
- **Advisory wording, never imperative.** dsh-anchored-monitor's hint templates carry an
  experimental discipline (E1/E1.5): *imperative* phrasing (`must`/`first`/`follow`)
  pushes a `we` trajectory back to `let me` — that is, a badly-worded pull-back makes the
  very signal it is trying to fix worse. Every branch of `pullbackText()` states facts and
  suggests, and invariant **C17** fails the build on imperative wording, on a missing
  suggestion, or on a missing exemption **per branch**.
- **Explicit exemptions**, because a nag that punishes normal work is worse than silence:
  temp/venv/cache paths are not scope violations, and documentation-only edits do not
  invalidate a verification (that was exactly the audited false-positive class).
- **Throttled like a signal, not a stream:** at most once per turn (allostasis
  `admitPerTurn`) and at most `pullbackMaxPerSession` (3) per session, with the
  suppressions counted in `anchor_status` (`pullback.suppressed.throttled/cap/noAnchors`).
- **Never guesses:** if the prompt has no readable scope clause, nothing fires
  (`noAnchors` increments) and `taskAnchors.parsed` stays `false`.

`tools/test-pullback.mjs` (28 cases) drives a real `apply()` and asserts both
directions for every claim: it fires on an out-of-scope write and stays silent in scope;
it reminds after a code edit and stays silent after a documentation edit; it fires once
per turn, stops at the session cap, stops after a re-verification, and does nothing at
all when disabled or when the prompt has no scope clause — plus that the injected text
contains evidence and exemption and **no** imperative verb.

### Re-anchoring (L2): the strongest action, behind the hardest gate

`reanchorEnabled` (default **`false`**) puts the **first-round Minimal payload back into
the near-term position** — following the community precedent (dsh-anchored-monitor's L2
is "reset the payload, byte-identical to the official Minimal preset"), because inventing
new wording carries a risk the wording-discipline finding already demonstrated.

It is deliberately harder to turn on than the capability layer, because it rewrites what
the model *reads*:

| Gate | Condition | Visible as |
|---|---|---|
| switch | `reanchorEnabled`, default off | `reanchor.gate = 'switch-off'` |
| **online evidence** | `reanchorEvidencePath` → `verdict: 'PASS-online'`, unexpired, and **not synthetic** | `'evidence-REJECTED'` / `'no-online-evidence'` |
| evaluation protection | `measurementSafe` | `'measurement-safe'` |
| self-demotion | `autoDemote` | `'auto-demoted'` |
| **light before heavy** | L1 must already have spoken, with new evidence since | `reanchor.suppressed.noPriorPullback` |
| once per session | — | `reanchor.suppressed.alreadyDone` |

The evidence is not a promise, it is a file produced from real sessions:
`recordPullbackOutcome()` appends one JSONL line per session that actually received a
pull-back (only when `pullbackEnabled` is on), recording directly observable proxies —
`verifiesAfterPullback`, `scopeViolationsAfter`, `claimedUnverifiedAfter` — and
`tools/analyze-pullback-outcomes.mjs` turns those into the artifact (`< minSamples` ⇒
`INSUFFICIENT` ⇒ the gate stays shut; improvement ≥ 50% ⇒ `PASS-online`; 14-day expiry).
Walking that chain end to end surfaced a real risk: the synthetic data used to exercise
it *opened the gate*, so the loader now rejects `synthetic: true` outright.
`tools/test-reanchor.mjs` (26 cases) covers all five gates in both directions, and
invariant **C18** pins — per function — the ordering rule, the once-per-session rule, the
persona being carried verbatim, the advisory wording, and that the collector is actually
called, with six deliberately broken copies all failing.

Consequently the shipped `responsePolicy.json` records **verdict `FAIL` with zero
capability-eligible channels**, and the capability layer stays off. The gate is not
"off by default and untested" — it is *closed because the only available signal was
measured and rejected*, and the machinery to open it (artifact → eligibility →
derived parameters → effective switches) is verified end-to-end by gate case ⑪.

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

**Family-prior shrinkage (L3, second layer).** The *first* layer is the session-local
self-reference test above; the second says "unusual" is relative to the model, not to a
global constant. `tools/family-priors.mjs` measures per-family base rates from real
sessions — family key = `provider/model @ agentPreset @ declared-scope`:

| family | sessions | steps | repetition base rate | failure base rate |
|---|---|---|---|---|
| `deepseek-official/deepseek-v4-pro` | 45 | 20,546 | 0.0543 | 0.0376 |
| `…/deepseek-v4-flash-vision-exp` | 13 | 13,403 | 0.0413 | 0.0270 |
| `…/deepseek-v4-flash` | 11 | 5,600 | 0.0362 | 0.0364 |
| `huoshan/ark-code-latest @ workspace` | 4 | 249 | 0.0361 | **0.0884** |
| `vision-toolkit-…/deepseek-v4-pro` | 2 | 806 | 0.0645 | 0.0261 |

Failure base rates differ by **3.4×** across families, so "2 failures in 3 steps" is not
equally surprising everywhere. With `familyPriorPath` set, the null rate is estimated from
*both* sources (`pHat = (refHits + rate·S) / (refLen + S)`, `S = priorStrength`) — proper
shrinkage: early in a session the family dominates, and as the session's own reference grows
its data takes over. Unreadable, unknown-family and empty-table cases fall back to the fixed
Jeffreys pseudo-count, verified to be **bit-identical** to pre-prior behaviour, and every
channel row exposes the prior it actually used. `agentPreset` is `(none)` throughout this
corpus: the axis exists but carries no information today — recorded rather than assumed.

Measured effect at α=0.01 (session hit rate): repetition 31.2% → **33.8%**, failure
41.6% → **45.5%**, inaction 14.3% → 14.3%. The shrinkage makes these tests *more* sensitive
here because the families' base rates sit below the Jeffreys-implied null rate — which is
exactly why **α must be re-derived once the prior is active**. `familyPriorPath` ships as
`null`, so shipped behaviour is unchanged and that re-derivation is a separate step. The
mechanism test avoids depending on displayed precision: with α placed *between* the two
p-values, the same session shape narrows in the low-base-rate family and does not in the
high-base-rate one.

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

### Runtime gate (B3): the capability layer has to earn permission, every mount

Offline qualification is not online qualification: corpora drift, models change,
task families change. So three independent gates sit in front of the capability
layer, and **each one fails safe** (observe-only) rather than open — a capability
surface is not a tool surface, and "exposing the full catalog" is the right
failure only for the latter.

| Gate | Trigger | Effect | Visible as |
|---|---|---|---|
| **Calibration artifact** | `responsePolicyPath` (or `TRAJECTORY_ANCHOR_POLICY_PATH`) points at a JSON file that is not an object, cannot be parsed, is expired (`expiresAtUtc`), or whose `verdict` is not `PASS`/`PARTIAL-PASS` | capability layer off; a loud one-shot warning records why | `capabilityGate: 'policy-REJECTED'`, `policyArtifact.rejectReason` |
| **Evaluation protection** | the artifact declares `measurementSafe: true`, or config sets `measurementSafe: true` | **both** layers off — a benchmark score must not be attributable to this plugin | `capabilityGate: 'measurement-safe'` |
| **Online auto-demote** | in the last `autoDemoteWindow` finished sessions, the share that narrowed at least once exceeds `autoDemoteBudget` | capability **and** notification off for the rest of the process, with an `auto-demote` audit event | `capabilityGate: 'auto-demoted:<reason>'`, `sessionOutcomes` |

A passing artifact grants eligibility **per channel** (`capabilityEligibleChannels`)
and may carry re-derived parameters (`channels.<name>.derived.{alpha, consecutive}`),
which are written into the live channel config — so the same deviation shape can
narrow under one calibration and only notify under another. The artifact gates the
**capability** layer only: notification is instrumentation, it changes neither the
tool surface nor the context, and it keeps working (under its own `notifyAlpha`
budget) while the capability layer is barred. Every effective value is visible in
`anchor_status` — `effectiveSwitches`, `capabilityGate`, `policyArtifact`, and per
channel `actAlpha` / `notifyAlpha` / `consecutive` / `fireRun` / `notifyRun`.

Three failure modes found and fixed while building this gate (all three now
asserted, and each assertion is negative-tested against a deliberately broken
copy under `D:\DSHwork\scratch\inv-neg-b3\`):

1. **Sticky state across mounts.** `apply()` used to keep the module-level
   `CONFIG` from the previous mount, and `{ ...DEFAULTS }` is a *shallow* copy —
   so loading an artifact mutated `DEFAULTS` itself, and an artifact's
   `measurementSafe` / eligibility / derived α survived into the next mount
   ("I removed the artifact and the behaviour did not change"). `apply()` now
   re-seeds `CONFIG` from `DEFAULTS` (deep) and clears the gate state.
2. **Two-tier counter mixing.** The consecutive-confirmation counter was
   incremented at `notifyAlpha` but used to guard the `actAlpha` capability
   tier — i.e. the online decision was *looser* than the offline calibration,
   which counts runs at a single α (`behaviour-channel-core.mjs walkChannel`).
   That is precisely "passes offline, exceeds budget online". The counters are
   now kept per tier (`fireRun` at `actAlpha`, `notifyRun` at `notifyAlpha`).
3. **Decision-relevant p was unreadable.** `round2()` printed both `3e-3` and
   `9e-6` as `0`, so with α at `1e-5` the audit could not say *why* a step acted.
   Probabilities now keep two significant digits below `0.001` (`roundP`).

`tools/test-policy-gate.mjs` (39 assertions) drives real `apply()` for all five
must-observe cases plus the auto-demote path, and keeps **both directions** of
every claim: the same synthetic deviation narrows with a permissive artifact and
only notifies with a derived `α = 1e-5`; a `k = 3` requirement neither fires
early nor never fires; a mixed-tier counter fails while a per-tier counter holds.
`tools/check-invariants.mjs` asserts the wiring statically as **C13** (re-seed
present, `hitAct` measured at `actAlpha`, `strong` requiring action-tier
confirmation, and no raw `CONFIG.rollbackEnabled` / `CONFIG.notifyEnabled` read
outside the gate functions), and pins the version lineage as **C14** (the README
must name the `package.json` version — the drift that motivated it was commits
advertising 0.4.8/0.4.9 while `package.json` still said 0.4.7). Both C13 and C14
were verified against deliberately violated copies, not just against the good one.


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

### Full automation loop (L4): produced, gated, and measured by itself

`tools/auto-loop.mjs` is the closure: it regenerates the family priors, re-derives α **with**
the prior active (shrinkage changes the null rate, so re-deriving is not optional — measured:
A′ goes from `0.001` to `0.0001`, 10× tighter, otherwise the budget is silently widened),
runs the 20 invariants **plus all fourteen suites as its own gate**, produces the online
evidence when outcome data exists, and prints the enablement checklist. Any failing step exits
non-zero: "refuse to publish" is a hard failure, not a warning.

Two structures make that measurement possible rather than aspirational:

- **Two α sets in one artifact.** `derived` (no prior) and `derivedWithFamilyPrior` both ship;
  the runtime picks by whether priors are *actually loaded* and records
  `policyArtifact.derivedSource`. Load order matters — the test caught the reversed order as
  "priors loaded, but the no-prior α used."
- **A control arm.** `pullbackControlRate` (default `0`) suppresses the message on a trigger
  with that probability, so the outcome log contains *intervened* and *control* sessions
  rather than only the treated side. `analyze-pullback-outcomes.mjs` then does a one-sided
  Fisher exact comparison and demands direction **and** significance **and** an absolute
  level: single-arm ⇒ `INSUFFICIENT` ("cannot estimate"), control better ⇒ `FAIL`, a tie ⇒
  `FAIL` (not demonstrated better), positive-but-not-significant ⇒ `INSUFFICIENT` (keep
  sampling, don't gamble). Only a significant positive effect opens L2.

Running the loop for the first time immediately caught a silent loosening: without a recall
report it produced a *looser* artifact (`PARTIAL-PASS`, two channels granted). C16 and gate
case ⑪ refused to publish it, but the fix belongs at the source — the calibrator now makes
"no recall evidence ⇒ no eligibility" a hard rule (`recallOk = Boolean(recallSide) && …`),
and invariant **C20** pins that, the loop's gate coverage, and its non-zero exit.

**Enablement checklist** (each step requires evidence first; shipping everything off is the
design, not an unfinished state): observe → L1 (`pullbackEnabled`) → collect both arms
(`pullbackControlRate` 0.2–0.3) → require `PASS-online` → L2 (`reanchorEnabled` + evidence
path) → L3 (`familyPriorPath` + `outcomeFeedbackEnabled`) — with `measurementSafe` or the
self-demotion available at any point.

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
- Live state: the `anchor_status` tool (globally registered, read-only). Beyond the
  per-agent rows it reports the plugin-level gate state: `capabilityGate`,
  `effectiveSwitches`, `policyArtifact`, `autoDemote`, `sessionOutcomes`,
  `configWarnings`, `policy` / `policyAction` / `policyP` / `policyReason` per session,
  and the per-channel snapshot (`channels`, `channelWindows`) with the effective
  `actAlpha` / `notifyAlpha` / `consecutive` and the two live run counters
- Assertion suites (all must stay green; each is run against `index.js` by path):
  `tools/check-invariants.mjs` — 18 static invariants (C1–C18), 0 debt;
  `tools/test-runtime-lexicon.mjs` — 64 pure-function cases;
  `tools/test-anchor-contract.mjs` — 24 install-and-use / contract cases (incl. the
  "apply() with no config at all" mount and a lossless-JSON walk over live rows);
  `tools/test-response-policy.mjs` — 30 end-to-end policy cases (A…J);
  `tools/test-policy-gate.mjs` — 47 B3 gate cases (artifact / expiry / evaluation
  protection / auto-demote / two-tier counters / the shipped artifact end-to-end,
  each with its opposite direction);
  `tools/test-drift-label.mjs` — 35 labelling cases (metrics, anchors, and the
  circular-labelling guard proven load-bearing);
  `tools/test-task-anchor.mjs` — 55 task-anchor cases (clause parsing in English and
  Chinese, "never guess" on prompts without a scope clause, scope scanning, and the
  four audited false-positive classes pinned as regressions);
  `tools/test-pullback.mjs` — 28 L1 cases (fires/stays-silent both ways, turn throttle,
  session cap, re-verification clears the reminder, wording has no imperative verb);
  `tools/test-reanchor.mjs` — 26 L2 cases (all five gates both ways, light-before-heavy,
  once per session, persona carried verbatim, synthetic evidence rejected, outcome JSONL
  written only when a pull-back actually happened);
  `tools/test-family-prior.mjs` — 20 L3 cases (higher-base-rate family ⇒ strictly larger p,
  the decision flips when α sits between the two p's, and unknown-family / broken-file /
  empty-table all fall back to *bit-identical* pre-prior behaviour);
  `tools/test-ledger-semantics.mjs` — 11 hand-computed finalization cases (ground truth
  for the four ledger paths, including the two the real corpus never exercises);
  `tools/test-ledger-parity.mjs` — 14 live-vs-batch parity runs (4 synthetic streams +
  3 real sessions, every decision point compared);
  `tools/replay-interventions.mjs` — bounded episodes, compliant end reasons, replayable
- Shipped calibration artifact: `responsePolicy.json` — verdict **`FAIL`**, zero
  capability-eligible channels, the false-alarm sweep per channel, the **measured
  recall side** with its conclusion, the G3 negative control, and a corpus
  fingerprint (count / bytes / newest mtime). It is **not auto-loaded**
  (`responsePolicyPath` defaults to `null`), so a fresh install observes only; the
  same file is the input `tools/measure-recall.mjs` reads for its α/k, and the
  loader refuses it while the verdict is not `PASS`/`PARTIAL-PASS` (invariants C16 +
  gate case ⑪ keep the artifact and the loader in agreement).
- Event-sequence assertion: `adopted → anchored → context-suppressed → maxTokens-rewrite →
  gate-armed → lift(anchor-gate:minimal-like | max-steps) → context-restored →
  maxTokens-strip → score… → closed + record(incl. reward)`

## License

MIT.
