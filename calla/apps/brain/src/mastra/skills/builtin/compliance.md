---
gdpr_applicable: true
eu_ai_act_disclosure: true
opt_out_permanent: true
data_retention_days: 90
unsubscribe_header: true
---

# Compliance

## GDPR
- Every email includes physical address (from brand settings)
- Every email includes "Reply STOP to opt out"
- Opt-out is permanent and enforced in every send gate
- `/erase` command performs permanent data deletion (unlogged)
- Contact data on opted-out leads is purged after 90 days
- Data export available via `/export-csv` (right of portability)

## EU AI Act
- All outreach emails include an AI disclosure line
- Disclosure states the initial contact was AI-assisted
- Human interaction is offered at the earliest point (demo call)

## Opt-Out Policy
- "STOP", "unsubscribe", "remove", "opt out" in reply triggers permanent flag
- Blacklisted domains are skipped during crawl intake
- No re-engagement attempts after opt-out

## Send Safety
- Dry-run is default ON — no emails sent until human enables
- Daily send cap defaults to 10
- Per-domain deduplication enforced
- `List-Unsubscribe` header included in every email
- MX validation required before any send
