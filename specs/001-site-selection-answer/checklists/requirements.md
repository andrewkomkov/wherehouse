# Specification Quality Checklist: The site-selection answer flow

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Project-specific gates *(from .specify/memory/constitution.md)*

- [x] **I — the answer is a visual artifact**: FR-001/FR-002 make layers the output and cap
      prose at two sentences; SC-006 tests it.
- [x] **II — claims verified against the live system**: the Verified Measurements section
      records executed queries and their output. The saturation constant was *measured* wrong
      (p75 of a distribution running to 64), not argued wrong. A new silent trap (`h3ToGeo`
      is lat-first) was found by executing rather than reading.
- [x] **III — riskiest path first**: the 1 MiB cap is FR-011..FR-015, and FR-014 forces the
      by-reference path onto the demo's happy path so it cannot rot until day 6.
- [x] **IV — infrastructure is code**: no new infrastructure; the by-reference store reuses
      the proven ADR-003 mechanism and the existing `site` user.
- [x] **V — secrets never enter git**: no credential surface added. The browser reaches
      ClickHouse with the existing public read-only token, the same posture as
      `play.clickhouse.com` (ADR-003).
- [x] **VI — scope bounded by the clock**: Out of Scope table states seven cuts with reasons.

## Notes

**Deviations from the generic template, made deliberately:**

- The template says "no implementation details". This spec names `h3kRing(h3_8, 1)`, the
  1 MiB cap, and the 256 KiB budget. That is not a leak — constitution II ranks over the
  template ("a claim that matters is a claim that has been executed"), and these are the
  *measured constraints the feature must be designed around*, not chosen implementations.
  The 1 MiB cap in particular is a platform fact that cannot be raised; a spec that omitted
  it would be specifying a feature that crashes.

- Zero [NEEDS CLARIFICATION] markers. Two candidates were resolved from data rather than by
  asking:
  - *the saturation constant* → measured the distribution; p75=4, max=64 ⇒ the constant is
    empirically wrong, and percentile scaling replaces it (FR-007, FR-010).
  - *ring radius* → k=1 at res 8 ≈ 1.2 km, a walking catchment for a trade people walk to.
    Documented as an assumption, revisitable per-category later.

**Open risk carried into planning** (not a spec defect — a known limit, stated in the spec):
a maximal score can mean "a park with nobody selling bread in it". Land use is out of scope
for day 3. If the top-3 in the real demo lands on a cemetery, that is a plan-time problem and
the mitigation is a candidate-cell filter, not a score change.
</content>
