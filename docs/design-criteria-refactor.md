# Criteria-Layer Refactor: Statistical Channels → Self-Verifiable Facts

Status: **design proposal** — phase 1 of the three-part plan (criteria refactor → intervention
upgrade → n≥8 measurement). Not implemented. Grounded in the measured state at commit `79a8fa1`
(see the project ablation log, §§27–31).

## 1. Why this refactor

Honest measured status of the four intervention lines:

| Line | Acceptance | Measured outcome |
| --- | --- | --- |
| L1 / L2' informational (A/B) | mechanism fires | mean −2.6, p=0.254, n=5 — no attributable effect |
| contract-reanchor v1 | 3/3 silent-switch fail | n/a |
| done-gap v1 → v2 → v3 (lazy) | 0 → 4/5 → 5/5 fires | +0.8, ns, n=5 |

The one mechanism that demonstrably **engages** the agent is the done-gap mirror: replaying the
agent's own failing verification evidence against its own completion claim. This refactor
generalizes that discovery across the whole criteria layer.

**Hypothesis:** informational nudges derived from statistical scores are ignorable; mirrors of the
agent's own transcript evidence are not.

Two failure modes of today's statistical criteria:

1. **False positives.** Legitimate long research scores as "inaction"; legitimate retry scores as
   "repetition"; honest failure reporting scores as the "failure" channel. A smoothed score cannot
   distinguish drift from its legitimate correlates.
2. **Non-actionability.** "Repetition score 0.8" carries no evidence the agent can check. An
   accusation without evidence can be dismissed.

## 2. Design principle

**Every criterion is a deterministic predicate over transcript facts, and every fire carries
verbatim evidence.**

- Triggers are settled facts (predicates over recorded evidence), not smoothed scores.
- Fires carry the exact claim text, verification output tail, file paths, and command line that
  ground the fact.
- Scores (ratio / band / percentile / EWMA) stay, but are demoted to audit diagnostics; no
  intervention may fire on a score alone.
- Extraction happens once at record time, append-only, keyed by turn index — an extension of the
  existing audit.

## 3. Fact taxonomy

| ID | Fact | Predicate | Evidence carried |
| --- | --- | --- | --- |
| F1 | done-gap (delivery) | final message has a delivery-style completion claim ∧ last captured verification shows failures (or no verification since the last artifact change) | claim quote + last verify output tail + fail count |
| F2 | itemized claim-vs-evidence | message asserts "X passed / fixed / complete" for item X ∧ (no verification output for X ∨ latest output for X shows failure) | itemized claim + the missing or contradicting output |
| F3 | scope breach | any file write/edit outside the declared scope spans | out-of-scope path list + scope quote |
| F4 | plan-action divergence | an explicit multi-step plan was stated ∧ a step was skipped or replaced without note | plan text + the call sequence |
| F5 | verification staleness | a claim cites verification V of artifact P ∧ a write/edit to P occurred after V ran | V quote + the post-V edit call |
| F6 | unsupported outcome assertion | final message asserts a measurable outcome (count / percent / "works") with no tool result that could have produced it | the assertion + the list of all verification outputs |
| F7 | evidence contradiction | two transcript facts conflict (a run shows 3 failures; a later message says all pass; no new run) | both quotes + turn indices |
| F8 | identical-call loop | the same command+args repeated ≥N times with no interleaved state change | the call + repeat count |
| F9 | no-action epoch | zero tool calls for K consecutive turns ∧ no deliverable in those turns | turn indices |

Migration map: inaction → F9; repetition → F8; failure → F1/F2/F5/F7; scope detection → F3.
The old channel statistics remain in the audit view as diagnostics.

F1 is already implemented (`tools/test-done-gap-mirror.mjs`, 14 cases; live acceptance: 5/5 fire,
outcome +0.8 ns).

## 4. Evidence capture (record time)

New per-turn record fields (bounded quotes only; no live objects — serialization discipline):

- `claims[]`: `{ text (bounded quote), target ('delivery' | item id), turn }`
- `verifyEvidence[]`: `{ artifact, cmd (bounded), outputTail (bounded), failCount, ranAt }`
- `scope`: declared scope spans + `touchedFiles` `{ path, op, turn }`
- `planSteps[]`: `{ n, text, executed? }`
- `edits[]`: `{ path, turn }` — powers F5 without filesystem access: staleness = an edit to P
  after the verification of P ran (tool-call order)

## 5. Interventions consume facts only

- Triggers switch from score thresholds to fact predicates.
- Every intervention becomes a mirror: **[what you claimed] + [the evidence] + [the imperative]**.
- The imperative is a protocol constraint, not a suggestion: "re-run X now and paste the output",
  "revert or justify", "state your next concrete action". This is the hand-off to the phase-2
  actuator upgrade (protocol/budget-type), with the existing informational arm kept as the
  measurement control arm.
- One-shot per fact instance (existing `served` semantics, as in done-gap v3).

## 6. Anchoring the better reasoning

Bootstrap tool surface, Minimal persona, promotion gate, and context suppression stay unchanged —
mechanism-verified. New: **round-1 verification-protocol capture** — after first delivery, extract
the claim⇒evidence pattern of round 1 (which claims were backed by actual runs) and store it as the
anchor template; re-anchor mirrors then cite the agent's own round-1 example. Operationally that is
what "locking in the better behavior" means.

## 7. Out of scope

No change to bootstrap anchoring, the promotion gate, context suppression, L3 priors, L4 export, or
the append-only audit format. Scoring remains (observability value). No effect claims before the
gates in §8 pass (standing discipline).

## 8. Validation gates (per fact, before wiring to a live intervention)

1. Unit tests per fact (done-gap style), including negative-verification cases — a deliberately
   broken extractor must fail.
2. Replay every historical transcript (A/B runs, live sessions): fire rate + manual review of
   every fire → false-positive rate.
3. Live fire-rate acceptance before any score comparison (the pre-registered gate style).
4. A/B with n≥8 and extra metrics: early-stop rate, duration, destructive-regression rate, and
   intervention-vs-control step/token delta (closes the open cost-side debt).

**Known risks:** facts can also false-positive (e.g., F5 fires on a cosmetic post-verify edit; F2
misattributes an item). Mitigation: evidence is quoted verbatim, so the agent and the audit
reviewer can adjudicate each fire; precision is measured in gate 2 before any A/B.

## 9. Implementation order

1. Evidence capture at record time (extend `rec`; unit tests; keep the auto-loop closure list in
   sync).
2. Ship F1 (exists) + **F3 + F5** first — highest precision, cheapest evidence.
3. Mirror interventions on F3/F5; A/B vs control.
4. Add F2/F4/F6/F7/F8/F9 based on measured precision from step 2's replay.
5. Re-word the README value proposition honestly (mechanism-verified; effect under measurement).

Phases 2 (protocol/budget actuator) and 3 (n≥8 measurement with extra metrics) build directly on
this layer: phase 2 consumes the facts, phase 3 measures them.
