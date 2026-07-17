# Specification Quality Checklist: The walk catchment, and Accessibility as a real factor

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-17
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

## Constitution II — every claim in this spec was executed

The rule that this project keeps failing is not "measure things"; it is *"a number is not
evidence for the words next to it"*. So the prose was audited separately from the data, and
that audit found a defect:

| Claim as first written | Verdict | Resolution |
|---|---|---|
| Unmeasured Berlin cells average **346** residents | **WRONG** | 346 is the mean of a *different* sample (the 704 cells with no covered child at all). The centre-child set is 830 cells averaging **375**. Corrected, and the error is documented in-place rather than quietly fixed. |
| Central Belgrade is denser than central Berlin | true, but **unverified** when written | Now checked against our own `geo.population`: peak 20,305 /km² vs 11,795 /km². It survived only because the check was run. |
| Berlin mean density ~4,000 /km², centre ~9,000 /km² | recollection, not data | Removed. The sanity table now derives density from `geo.population` itself. |
| 445 of Berlin's contours are multi-lobed | true | Re-verified live (445 contours / 462 extra rows) rather than cited from our own doc. |
| Coverage figures, acc percentiles, the reaches-self invariant | true | Executed 17 Jul against 26.4.1.2029; the queries are in the session log. |

**Notes on the shape of the spec**: the central section is not a requirement list but an
argument about what an absent measurement means. That is deliberate — every FR about the
"not measured" state is downstream of it, and a reviewer who disagrees with that section should
stop there rather than argue with FR-008.

## Notes

- Ready for `/speckit-plan`. No open clarifications: the one real fork (what happens to
  unmeasured cells under a non-zero Accessibility weight) was put to the user before the spec
  was written, and the decision — an explicit "not measured" state, excluded from ranking, with
  a surfaced count — is encoded in FR-008/009/010.
