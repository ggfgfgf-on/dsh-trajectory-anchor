# Intervention Upgrade: Informational Mirrors → Protocol/Budget Constraints

Status: **design proposal** — phase 2 of the three-part plan. Grounded in the measured state at
commits through `c751890` (see the project ablation log, §§26–36). Not implemented.

## 1. What the measurements say so far (all pre-registered, all honest)

| Intervention | Type | Measured result |
| --- | --- | --- |
| L1 pullback | informational nudge | fires (4× live) but no attributable outcome effect (A/B −2.6, p=0.254) |
| L2' confirm-reanchor | informational re-injection | fires, no attributable effect |
| contract-reanchor v1 | informational summary | 3/3 silent-switch fail |
| done-gap mirror v1→v3 | informational evidence mirror | 5/5 fire, +0.8 ns |
| F3 scope-breach / F5 verify-staleness mirrors | informational evidence mirrors | replay precision fixed (gate 2), live A/B in flight — fires 0/6+ so far |

Two robust findings:

1. **The task's actual failure mode is claim-vs-evidence on the hidden grader.** ark and
   v4-flash both declare completion citing PUBLIC test results while the hidden grader stays at
   23/45, or declare done with probe failures hand-waved as "environmental". This is the F1/F7
   fact family, not F3/F5. F5 rarely fires because agents end with a verify (public), not an edit.
2. **Informational delivery of facts does not change behavior.** Five independent informational
   mechanisms, zero attributable effects. The agents read the evidence and rationalize it away
   ("these failures are expected / out of scope").

Hypothesis for phase 2: **the lever is not what the intervention SAYS but what the intervention
PERMITS.** An informational mirror can be ignored; a delivery-protocol constraint cannot be
ignored without the agent openly violating an explicit gate — and that violation is itself
measurable.

## 2. Design principle

**Interventions become protocol constraints with explicit budgets, not suggestions.**

- Each constraint is stated as a rule the delivery must satisfy ("you may not declare done
  unless X"), enforced by REFUSING the delivery claim, not by narrating evidence.
- Every constraint carries a budget (once per claim, once per N edits) so it stays a gate and
  never becomes a conversation.
- Facts (F1/F3/F5/F7) stay the TRIGGERS; only the actuator semantics change from mirror to
  protocol. The criteria layer from phase 1 feeds this layer unchanged.

## 3. The three constraints (P1–P3)

### P1 — delivery gate (the primary upgrade)
At a delivery-style claim:
- IF the last **hidden-grader-style** verification (the task's own grading command — now
  recognized after the `c751890` fix) shows failures, OR ran before the latest code edit,
  THEN the claim is answered with a REFUSAL section: the delivery statement is not accepted,
  and the agent must re-run the grader and quote its `[hidden]` line verbatim.
- Budget: fires at most once per session (one-shot, like the mirrors).
- Evidence: the failing grader output tail (already captured as verify-evidence).

### P2 — verify-after-edit budget
After any code edit (changeInvalidatesVerification) following a verification:
- the next prompt assembly injects ONE mandatory step: "re-run <last grading command> and
  quote the result before further edits".
- Budget: at most once per K=3 edits (rate cap), so it cannot dominate the session.

### P3 — claim-format contract
The first instruction often declares a report format (PASS=n/m). When `reportFormat` is parsed
from the task anchors, a delivery that omits or violates that format is answered with a request
for the exact line (no format, no delivery).

All three are **read-only in the capability sense** (they add prompt text, never remove tools or
messages) — the refusal is a message, but it is a GATE message that the agent's own protocol
requires it to satisfy. Risk class stays informational-plus, not capability-removal.

## 4. What changes vs the mirror era

- The trigger set is unchanged (facts with verbatim evidence).
- The response changes from "here is your evidence, keep fixing" (ignorable) to "your delivery
  is not accepted until <constraint> is satisfied" (protocol).
- The measured outcome of interest also changes: **claim-acceptance rate** and **re-grading
  rate after refusal** become the primary process outcomes, alongside the final score.

## 5. Validation gates (pre-registered, per constraint)

1. Unit tests per constraint (refusal wording, budget accounting, one-shot semantics, negative
   controls: a green fresh hidden run must NOT be refused).
2. Replay over the 197-session corpus: measure how often each constraint WOULD have fired, and
   manual-review every refusal for correctness (same gate as F3/F5's gate 2).
3. Fire-rate acceptance (≥5/8 in the intervention arm) before any score comparison — the same
   pre-registered gate as phase 1.
4. A/B (n≥8 pairs) with the phase-1 metrics plus claim-acceptance and re-grade rates.

## 6. Open questions

- P1's "hidden-grader-style" classifier: hidden/full/optional grading scripts vs public tests.
  The `c751890` run_* pattern catches both; a separate grader-tier tag may be needed
  (hidden/full vs public) to prefer the task's own grading criterion.
- Refusal channel: reuse `trajectory-anchor:*` sections, or a stronger channel (blocking the
  delivery message itself)? Reusing the section channel keeps it reversible; blocking delivery
  is a capability-plane change and needs the trial-release discipline (explicit channels, α,
  expiry).
