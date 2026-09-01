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
bun run check                        # typecheck + host tests
bun run push --host <console-ip>     # rebuild the guest, hot-push it (~20 s)
bun run probe --host <console-ip>    # status, stats, tree, screenshot
bun run 3ds                          # the full .3dsx — needed for a reflash
bun run daemon --unicast <console-ip>
```

`app/` and `mirror/` changes are hot pushes. A change under
`vendor/pocketjs/hosts/3ds` is native: rebuild the `.3dsx`, copy it to the SD
card, relaunch. **ftpd cannot run while Pocket Term does** — one homebrew
application at a time — so a reflash needs the console back at the Homebrew
Launcher.

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
- **TCP 8622 is usually taken** by another companion on this machine; the
  daemon falls back to an ephemeral port and the beacon advertises it.
- **Broadcast is filtered on many networks.** `--unicast <console-ip>` beacons
  straight at the console; the device connects to the datagram's source
  address at the advertised port.
