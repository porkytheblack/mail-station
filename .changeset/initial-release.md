---
"mailbox-station": minor
"gmail-station": minor
"mailbox-station-conformance": minor
---

Initial public release. Drops the prior `@mail-station/*` scope; the three
packages are now published as bare names: `mailbox-station`, `gmail-station`,
and `mailbox-station-conformance`. Public API is unchanged from the design
spec; consumers update import paths only (e.g.
`@mail-station/mailbox-station` → `mailbox-station`).
