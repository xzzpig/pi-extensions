---
issue: 635
issue_title: "Forwarded accessIntent is dropped before Authorizer Chain escalation"
---

# Retro: #635 — Forwarded accessIntent is dropped before Authorizer Chain escalation

## Stage: Planning (2026-07-26T17:26:32Z)

### Session summary

Planned the fix for a third-party bug report (`LukeWang-Plus`): `buildForwardedAskDetails()` in `src/authority/forwarded-request-server.ts` drops `request.accessIntent` when reconstructing `PromptPermissionDetails` for a forwarded ask, so an Authorizer Chain link receives display strings instead of the child-fixed access facts.
Tracing the consumer surfaced a **second**, unreported defect from the same missing field: `delegation-envelope.ts` decides exclusion with `details.accessIntent?.surface ?? details.surface`, so a forwarded ask falls back to the *display* surface (the tool name, e.g. `write`) and a chain link's `allow` on a forwarded `path`-gate ask escapes the bounded-delegation checkpoint that ADR 0007 §5 applies to the identical local ask.
Plan committed at `packages/pi-permission-system/docs/plans/0635-forwarded-access-intent-to-authorizer.md` as two steps: one red→green cycle (projection + envelope pin + user-facing breaking-change docs) and one docs commit.

### Observations

- Third-party issue, so the `ask_user` direction gate was mandatory.
  It took three rounds: the operator first asked how #635 relates to #610 (which also has a provenance/serving-node flavor), then asked for concrete examples of the envelope side effect before deciding.
  Both follow-ups were legitimate — the first ask presented the envelope consequence abstractly, and an abstract security-boundary tradeoff is not decidable.
  Lesson for future planning asks: when a question is about a *behavior change*, lead with the concrete before/after scenarios, not the option labels.
- Operator decisions: (a) plan **#635 alone** but record the shared cross-issue principle so #610's planning session inherits a decided frame; (b) **accept** the delegation tightening and ship it as a **breaking change** (`fix(pi-permission-system)!:`, `23.0.3` → `24.0.0`).
- The #610 relationship resolved into a coherent principle rather than a merge: both issues stem from the serving node reconstructing a degraded projection of the forwarded request, but they pull in **opposite** disclosure directions — #635 wants richer evidence on a trusted in-process seam, #610 explicitly wants *less* text on the any-extension `pi.events` broadcast.
  The principle recorded as "Reconstruction fidelity at the serving node" (fidelity up for in-process seams, disclosure down for broadcasts) covers both halves.
  It goes in `docs/architecture/architecture.md` under `## The authority model`, not a new ADR — it is descriptive of already-decided architecture (ADR 0007 §5, ADR 0008 §2).
- The fix realizes an assertion ADR 0008 already makes: "a serving node's chain links … review forwarded asks against the child-fixed fact set."
  So the ADR needs no edit; the code was simply not yet true to it.
- Disclosure boundary is the sharp design point.
  `ForwardedAccessIntent` is structurally assignable to `ForwardedAccessFacts`, so `accessIntent: request.accessIntent` type-checks while carrying `requesterCwd` and `principal` at runtime — a silent widening `tsc` cannot catch.
  The plan uses a field-by-field `toAccessFacts` helper with an explicit `ForwardedAccessFacts` return type (compile-checked against future field drift) plus an exact-keys test assertion.
- Verified rather than argued that the `permissions:ui_prompt` payload is unaffected: `buildUiPrompt` (`src/permission-ui-prompt.ts`) reads only `requestId`/`source`/`surface`/`value`/`agentName`/`message`/`forwarding` and never `accessIntent`, so the #292 non-degraded-broadcast contract is byte-identical after the change.
- Scoping check that narrowed the blast radius: the tightening bites **only** when the cross-cutting `path` / `external_directory` gate raised the forwarded ask.
  A `bash` ask and a per-tool ask (where `tool.ts` sets `gateSurface = tcc.toolName`) already agree with the display surface, so they are unchanged — which also means #620's allow-capable opaque-**bash** adjudicator is untouched by this fix.
- Test-gap note worth carrying into implementation: `delegation-envelope.test.ts` tests the envelope over synthetic details and `forwarded-request-server.test.ts` tests the server over a fake escalator, but nothing composed the two.
  That gap is exactly why the forwarded escape went unnoticed, so the plan adds a composition test rather than two more unit assertions.
- Only one exact-object assertion on `escalate` exists in the suite (`grep -rn "escalate).toHaveBeenCalledWith({" test/` → 1 hit), so the red step is well bounded.
- No follow-up issues filed — #610 and #620 already exist and cover the deferred work.

## Stage: Implementation — TDD (2026-07-26T17:41:26Z)

### Session summary

Implemented both planned steps in two commits: `c0790ad6` (`fix!`) landed the `toAccessFacts` projection in `buildForwardedAskDetails`, the corrected `PromptPermissionDetails.accessIntent` doc comment, four tests, the migration note, and the `docs/configuration.md` sentence; `08164e85` (`docs`) landed the architecture doc's new "Reconstruction fidelity at the serving node" subsection, the `forwarded-request-server.ts` module-tree clause, and the package skill update.
Production change was ~20 lines (one new module-private function plus a conditional spread).
Test count 2668 → 2672 (+4); `check`, root `lint`, full `test`, and `fallow dead-code` all green.

### Observations

- The `tidy-first-assessor` returned "no preparatory tidying warranted" and explicitly declined to extract the file-local `makeQuery`/`makeLink`/`makeDetails` helpers from `delegation-envelope.test.ts` and `authorizer-selection.test.ts`, reasoning that the change touches neither file and that the new composition test deliberately uses the *real* captured details rather than a synthetic `makeDetails`.
  That is the correct scope boundary, and a useful data point for the assessor's first-live-use checkpoint.
- The red step was strong evidence rather than ceremony: the envelope-composition test failed with `expected { kind: 'allow' } to deeply equal { kind: 'defer' }`, which *demonstrated* the checkpoint escape rather than merely asserting the plan's claim about it.
  The plan predicted three of the five new/edited assertions would fail; exactly those three did, and the two written as guards (forwarded `bash` passes through; version-skew absence) passed from the start, confirming they guard rather than drive.
- Deviation from the plan, deliberate: the plan's invariants table proposed pinning the disclosure boundary with `Object.keys(details.accessIntent).sort()`.
  A whole-object `toEqual` on `details.accessIntent` is strictly stronger — `toEqual` requires matching key sets for non-`undefined` values, so it rejects a leaked `requesterCwd`/`principal` *and* pins the values — and matches the testing skill's "prefer strong assertions that match the entire expected value".
  The pre-completion reviewer independently endorsed this.
- `rumdl`'s `MD057` false-positived on the new `docs/configuration.md` migration link when it sat inside a parenthetical at the end of a very long line (column 321), reporting the target "does not exist" although it did.
  Splitting the line into three sentences (the project's one-sentence-per-line convention anyway) cleared it.
  Worth remembering: an `MD057` "does not exist" on a link whose target demonstrably exists is a line-length/parse artifact, not a broken path — fix the line, do not go hunting the path.
- No production change was needed in `delegation-envelope.ts`.
  Its existing `details.accessIntent?.surface ?? details.surface` already preferred the gate-authoritative surface; it simply never had one for a forwarded ask.
  The fix is entirely upstream of the checkpoint, which is why the blast radius stayed as narrow as the plan predicted.
- Pre-completion reviewer: **PASS** — ready for `/ship-issue`.
  No warnings.
  It independently verified all five invariants (including grepping `buildUiPrompt` to confirm it never reads `accessIntent`, rather than accepting the plan's claim) and confirmed zero diff on `delegation-envelope.ts`, `permission-ui-prompt.ts`, and `forwarding-io.ts`.
