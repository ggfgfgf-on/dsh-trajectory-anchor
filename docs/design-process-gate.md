# Process-Front-Loaded Constraints: the Next Iteration

Status: **implemented + measured** — Q1–Q4 shipped (ablation-log §46, commit `5e34fc2`);
Q1 A/B verdict recorded (§§47–48: fire-rate gate unmet ⇒ no score comparison, per
pre-registration); Q1' (§6 below) is the next iteration. Q2/Q3/Q4 await their live
fire-rate gates.

## 1. What the measurements established (design inputs)

1. **The delivery gate was right, but late.** P1 fired 7/8 (gate passed), changed behaviour
   (+0.9 min, +5.9 steps, +1.6 verifies, −0.4 claims per session) but moved the score by
   −0.25 (p=0.890). The re-grade rate after a refusal was **0/7** — and in 6/7 sessions the
   refusal landed after the session's **last tool call**: the completion claim IS the final
   message, so the gate fired into a turn that never came.
2. **A hard budget is a demonstrably different lever.** A 60-tool-call budget transformed
   v4-flash from non-termination (~200 steps, no settled outcome) to 44–45/45 in ~6 minutes
   (§37, n=3, uncontrolled, correlational — motivation, not proof).
3. **F6/F7 replay findings.** F6 (unsupported outcome assertion) would fire in 43.2% of claim
   sessions but many of them are non-engineering tasks where "run the grading command" is not
   actionable — it needs task-scoping. F7 fired 0× because its numeric full-pass trigger
   (PASS=n/n) is too narrow; agents phrase completion as text ("all green", "全部通过").
4. **P2 is already process-placed but never measured.** The verify-after-edit budget would arm
   in 60.8% of write sessions; it injects at assembly time (mid-session), unlike P1. It has
   never been A/B'd.

## 2. Design principle

**Constraints must bind inside the turn, not after it.** The failure mode of P1 was not the
predicate — it was placement: the intervention arrived when no further action existed. Every
constraint in this iteration therefore targets the earliest point where the fact is still
actionable, and every constraint is **budget-enforced** (it holds until evidence lands), not
one-shot informational.

## 3. The four constraints

### Q1 — deliverable-artifact gate (P1 re-placed mid-turn)
The task's real deliverable is a **file** (the `PULL_REQUEST_TEMPLATE.md` the runner prompt
requires), written *before* the final chat message. When the agent writes (or re-writes) the
delivery artifact:

- parse the artifact's final-verification claims;
- if the last grader run predates that write, or still shows failures ⇒ answer the write with a
  REFUSAL section quoting the grader evidence, and require the artifact to contain the verbatim
  `[hidden]` line.

Fires mid-turn (the artifact is written while the session is alive), so a re-grade after the
refusal is actually possible. One-shot per artifact write; re-armable per rewrite.

### Q2 — edit budget with teeth (P2 strength upgrade)
Every K landed code edits without an intervening verification ⇒ the next `agent/pre-step`
injects a **hold**: "no further edits until you re-run `<last grading command>` and quote its
output". The hold is stateful:

- edit attempts during the hold are allowed but counted (`hold-violations`, audit-visible);
- the hold releases only when a `verify-evidence` event lands after the hold started
  (budget recovery — evidence ends the constraint, not a timer).

### Q3 — F7' textual contradiction
Widen F7's trigger from numeric full-pass claims to textual completion forms
(`all (tests|checks) (pass|green)`, `全部通过`, `all green`) while the last verification still
shows failures. Reuses the F7 mirror channel and evidence formatting; replaces the numeric-only
predicate (kept as a sub-case).

### Q4 — in-session budget (the plugin's version of the §37 lever)
A hard cap on total landed code edits per session (default off; suggested trial value 60 to
mirror the observed budget effect). On exhaustion, the next pre-step injects a final
"budget exhausted — grade now and deliver" section and the session's further edits are
audit-flagged (not blocked). This is the in-plugin analogue of the prompt-side budget that
produced the §37 observation.

## 4. Measurement plan (pre-registered ladder, same as before)

1. Unit tests per constraint (both directions, hold-state transitions, budget accounting).
2. Replay over the 268-session corpus: fire/hold rates + manual review of every fire.
3. Live fire-rate gate: ≥5/8 sessions with the constraint active before any score comparison.
4. A/B (n=8 pairs, same task/seeds/protocol): primary = score delta; process outcomes =
   Q1 artifact re-write + re-grade rate (now measurable), Q2 hold-release rate and
   hold-violations, Q4 sessions that hit the cap; cost metrics as before.

## 5. Deliberate non-goals

- No capability-plane removal (no tool blocking) — holds are message-level and audit-visible.
- No change to the fact layer's triggers — only placement, statefulness, and wording strength.
- All four default off; the informational arm remains the measurement control.

## 6. Q1' — artifact-state binding (post-§48 fix; Q1's measured failure mode)

What §48 established about Q1 (every point audit-verified):

- Arming point = a tool-channel-observable `PULL_REQUEST_TEMPLATE*` write. Hit rate: **3/8**
  (below the pre-registered 5/8 gate ⇒ verdict "manipulation failed", scores never compared).
- Blind spot (a): **script-channel artifact writes** — m1-5 changed the template's file
  (SHA256 ≠ seed) while the audit holds zero template-write records; the gate never saw it.
- Blind spot (b): **hidden-verify-only predicate** — m1-2 ran public graders only, so the
  predicate can never arm regardless of behaviour.

Q1' replaces the *observation channel*, not the placement principle:

1. **Binding, not write-hooks.** On every grader-run verification (any kind — hidden/public/
   `run_*` grading scripts, the `verifyCommandKind` family), after the verify lands, bind the
   artifact's file state under the verified workspace: `{turn, step, path, mtimeMs, size,
   sha256}`. Every verification refreshes the binding — evidence ends the constraint, never a
   timer (same principle as Q2's hold release).
2. **Predicate at the next step boundary.** At each `agent/pre-step`, compare the artifact's
   live file state against the last binding; refuse (informational hold) when:
   - the artifact changed after the last verify (mtime/size/hash differs) — script-channel
     writes are caught because *file state* is observed, not tool calls; or
   - the artifact was deleted since the last binding (ENOENT).
   The binding records whether that verification still showed failures — the hold quotes those
   failures as evidence, but a red verify alone (with the artifact untouched) does not hold:
   red-green iteration is normal work, only an un-verified artifact *change* is a delivery.
   One hold per binding; the agent clears it by re-running any grader (the new verify re-binds).
3. **Deliberate limits.** Replay over the historical corpus can only measure the tool-channel
   subset (file mtimes are not in session logs) — the script-channel arm rate is live-audit-only.
   The refusal stays message-level; no capability removal (unchanged non-goals).

Audit: `artifact-binding` capture events + `artifact-stale-gate` refusal events; config key
`deliveryArtifactStateGate` (default off). Q1 (`deliveryArtifactGate`) stays as measured.

## 7. Measured status (ablation-log §§46–48)

| Item | Result |
| --- | --- |
| Q1–Q4 implementation | done (commit `5e34fc2`), all default off, protocol-gates suite 43 cases |
| Replay (268 sessions) | Q1 16 refusals; Q2 arms 64.7% of write sessions; Q3 2×; Q4 exhausts 7× (cap 60) |
| Q1 A/B (arm A, n=8, pre-registered §47) | **fires 3/8 < 5/8 ⇒ manipulation failed; scores never compared (barred by §47.3).** Arm B not run. Armed sites fired 3/3, served 3/3 |
| §47 process outcomes (n=3 armed sessions) | re-grade after refusal 1/5; artifact re-write 2/5; P1's structural flaw (artifact = final message) fixed where armed — m1-1 re-verified after the refusal |
| Q1 failure-mode autopsy (§48) | arming coverage 3/8: tool-channel-only observation (m1-5 script write invisible), hidden-verify-only predicate (m1-2 public-only never arms), 2 provider-failed sessions |
| Q1' artifact-state binding | this document §6; implementation + replay → ablation-log §49; live A/B needs its own pre-registration (§50) |
