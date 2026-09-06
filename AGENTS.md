# Working in this repository

Pocket Term is a product built on PocketJS, which arrives as the
`vendor/pocketjs` submodule. Nothing in `vendor/` is edited here: a runtime
change lands in [pocket-stack/pocketjs](https://github.com/pocket-stack/pocketjs)
first, and this repository moves its pin.

## Conventions

- Publish a change as a **draft pull request** before treating it as ready,
  and name it with Conventional Commits — `feat(app): …`, `fix(host): …`.
- Import PocketJS runtime, host component, lifecycle, input and animation APIs
  from `@pocketjs/framework/*`; import Solid primitives and control flow from
  `solid-js`.
- Prose states the mechanism and the reason. No slogans, no imported
  architecture jargon, no empty intensifiers.

## The loop

```sh
bun run check
bun run test:pty
bun run 3ds
bun run daemon --device <console-ip>
```

The pinned offload host reads its embedded guest and does not start the
legacy development server. Rebuild and copy the `.3dsx` through ftpd for
updates. `push` and `probe` apply only to the previous svc launcher.
**ftpd cannot run while Pocket Term does**; return to HBL to transfer files.

## Things that have cost time

- **The daemon runs under Node, never Bun.** Bun's `node-pty` spawn helper
  blocks forever in its slave-reattach `open()` on macOS 26; the PTY then only
  echoes kernel input. `bun run daemon` is `node host/serve.ts` for that
  reason.
- **A `class` string must be a whole literal in the source.** The compiler
  collects class strings at build time into a table the device looks up, so a
  string assembled at runtime — a template, a join — resolves to nothing and
  the node renders unstyled. Branch by returning complete literals.
- **The JS stack is spent on JSX nesting depth, not node count.** A QuickJS
  call frame is expensive and a mount descends the tree. One extra level under
  each key of the keyboard once overflowed the host's whole limit at boot;
  prefer an offset to a wrapper view when a wrapper only carries a position.
- **A long companion name is not a hypothetical.** `hostname()` gives
  "evandeMacBook-Pro" by default. Anything sharing a row with it is anchored
  to its own edge and given a measured width.
- **The status bar's host name is measured, not placed.** `getOps().measureText`
  in the title's own font slot is what keeps the title off it.
- **Blank runs count columns, not characters.** An ideographic space is two
  wide; treating it as one pulls the rest of the row a column left. Wide-glyph
  continuation cells are skipped, never treated as blanks.
- **A hot push restarts QuickJS but not the transport.** The daemon sees the
  same connection, so a `hello` resets per-replica delivery state — without
  that the fresh guest draws blanks where the old one drew CJK.
- **Terminal access uses paired io.offload.** `--device <console-ip>` (and
  the legacy `--unicast` alias) selects the provider destination. PKNT is
  loopback-only for Mac mirrors. `bun run pair` provisions both the existing
  dev key and the app-specific offload key.
- **Provider workers do not own PTYs.** They are destroyed on disconnect;
  `host/session.ts` runs in the durable Node terminal process. Keep the shared
  protocol in `shared/`, and preserve command ids across uncertain replies.
- **The terminal atlas has a 5px advance.** Regenerate `app/font.generated.ts`
  with `bun scripts/font.ts`; do not obtain 80 columns through negative
  tracking of the old 12px font. Status belongs on the auxiliary screen.
