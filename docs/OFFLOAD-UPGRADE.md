# Paired terminal upgrade validation

Validated on 2026-09-06 with PocketJS main `1c0735fa` and Pocket Doc's
`edd774b` provider/resource architecture as the reference.

**The top screen is an 80×24 terminal.** Every cell advances 5px and every
row occupies 10px. The generated terminal font replaces slot 16 when the
guest mounts. Box and block coverage reaches the cell boundaries. Status,
tabs and the keyboard occupy the auxiliary 320×240 display.

**Terminal sessions survive provider disconnects.** A durable Node process
owns node-pty, libghostty and scrollback. PocketJS's connection worker
forwards `term.exchange` to its authenticated loopback endpoint. Command
ids prevent duplicate execution after lost replies; acknowledged output
fragments retain delivery order. A changed epoch discards uncertain input
and resets the view.

| Check | Result |
| --- | --- |
| Guest and host TypeScript | Passed |
| Explicit unit suite | 42 tests, 1,021 assertions passed |
| Generated atlas | Reproduction matched; every advance is 5px |
| Provider and PTY integration | Passed with actual Bun workers, Node PTYs and libghostty |
| Production .3dsx and .pocket | Built using the pinned nightly and devkitARM container |
| macOS mirror | Guest bundle and release desktop host built |
| Native capture | Azahar dual-screen pixels inspected at 80×24, with paged tabs and keyboard |

The integration test force-closes the connection after commands, reconnects
the actual PocketJS provider, and resends the same command ids. A temporary
file proves one execution. It checks independent sessions, explicit
reattachment, 80×24 sizing, alternate screens, ANSI color, the last cell,
CJK atlas delivery, close/new-session behavior, terminal cursor-position
query replies, and exact bracketed paste bytes received by a foreground
program in raw mode.

The visual fixture uses its own app id and `pocketterm-qa.3dsx` output. Its
mock transport supplies deterministic rows; it is separate from the actual
provider integration test. The decoded native capture is
[terminal-80x24.png](terminal-80x24.png).

| Production artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| pocketterm-main.3dsx | 1,844,656 | `9f4a08ce175b4af4e6f9c2a40de0710cc39bb5d6de44465b323209f727fc5580` |
| pocketterm-main.pocket | 542,200 | `0d3fbec4f0fb72b05ade5d528dda861ded96a7f33da1d28964a252a4fe999a15` |

**Physical deployment and interaction remain pending.** The upgrade needs
the native launcher and an app-specific offload key. The pinned offload
host starts its embedded package without the legacy dev server; hot push
and dev-server screenshots are unavailable in this mode. Physical launch,
paired requests, touch/shoulder input and HBL return are separate acceptance
steps. The previous FTP receipt in `RUNTIME-UPGRADE.md` belongs to the older
57×17 svc build.
