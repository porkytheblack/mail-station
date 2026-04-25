# mailbox-station

## 0.1.0

### Minor Changes

- c9c38dc: Initial public release. Drops the prior `@mail-station/*` scope; the three
  packages are now published as bare names: `mailbox-station`, `gmail-station`,
  and `mailbox-station-conformance`. Public API is unchanged from the design
  spec; consumers update import paths only (e.g.
  `@mail-station/mailbox-station` → `mailbox-station`).
