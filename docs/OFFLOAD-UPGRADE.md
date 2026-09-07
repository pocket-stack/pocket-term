# Paired terminal upgrade validation

## Batched history revision

**Protocol 6 groups up to 16 history rows per network request.** Cache keys
remain individual absolute rows. At most two network requests and 32 logical
row loads are pending; materialization is bounded by eight rows and 4,096
serialized code units per frame, with one larger row allowed to progress.
[HISTORY-THROUGHPUT.md](HISTORY-THROUGHPUT.md) records the diagnosis, wire ceiling,
measurements and native comparison.

| Check | Result |
| --- | --- |
| Guest and host types; unit suite | Passed: 67 tests, 1,476 assertions |
| Actual provider and macOS PTYs | Passed: 2 integrations; bulk rows match single reads across append, reconnect and expiration |
| Cold-cache replay | 26 plain rows at 100ms RTT/60fps: 1,550ms before, 167ms after |
| Native motion | Same delayed fixture now has consecutive cached rows throughout frame 182; six frames inspected |
| Production launcher and Mac mirror | Built; app key path present, capture marker absent |
| Physical FTP deployment | Launcher and pairing key read back byte-identically on 2026-09-07 at 00:31 UTC |
| Physical revision acceptance | Pending fresh launch and fast-scroll testing |

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| pocketterm-main.3dsx | 2,027,600 | `21a4a120c9ef297856082cbac6d102dfdc021d08a3e5e1b8ed39f9940914d55b` |
| pocketterm-main.pocket | 725,144 | `b080e6f334108671de30fcfd95196fe6974bd18b3a1aea6fb0797ac90f3ed2ea` |

The new launcher is installed at `/3DS/pocketterm-main.3dsx`; the previous
version was backed up and verified at
`/pocketjs/runtime/native-backups/pocketterm-main-b349e7e97590e4d9.3dsx`.
The receipt is `.pocket/last-deploy.json`. The protocol-6 companion is running;
its trace is `.pocket/history-batch-daemon.log`. The previous worker's two
PTYs and two existing Mac mirrors remain alive in their original process,
not migrated into protocol 6. `.pocket/retired-protocol5-daemon.json` records
the process preservation.

## Responsive input and scrolling baseline

**Protocol 5 sends input independently of output delivery and batches ordered
keys.** Local scroll demand is planned in eight-row buckets, row movement uses
pixel translations, and releasing the stick carries its velocity into a fling.
The quiet lower screen has a settings key for fonts, preview and scroll speed.
Conservative provisional echo learns from confirmed application output.
The mechanism and simulated baseline comparison are in
[RESPONSIVENESS.md](RESPONSIVENESS.md).

| Check | Result |
| --- | --- |
| Guest and host types; unit suite | Passed: 60 tests, 1,441 assertions |
| Actual provider and macOS PTYs | Passed: 2 integrations, including batched Vim/Nano edits and lost-reply retries |
| All three font atlases | Reproduction matched |
| Production launcher and Mac mirror | Built; app key path present, capture marker absent |
| Native settings | Inspected; all three fonts and preview/speed controls fit |
| Native provisional echo | Inspected; pending third character and underline appear before authoritative output |
| Native inertial motion | Six consecutive frames inspected; unchanged pixels move 12, 11 and 10px in successive frames |
| Physical FTP deployment | Passed: launcher and pairing key read back byte-identically on 2026-09-06 at 23:23 UTC |
| Physical revision acceptance | Pending fresh launch and input/scrolling tests |

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| pocketterm-main.3dsx | 2,024,192 | `b349e7e97590e4d97bc43e53da9f1735fd979f65ce8dd5e7970bbda7b244355d` |
| pocketterm-main.pocket | 721,736 | `a486a182e912b9513b914ecaecf2e5c69b1c1d889c08db3de272e8a69aa47494` |

**The protocol-5 launcher was installed at `/3DS/pocketterm-main.3dsx`.**
The previous launcher was backed up and verified at
`/pocketjs/runtime/native-backups/pocketterm-main-6f65c3a374681c11.3dsx`.
That deployment's readback matched the artifact above. The latest receipt
now records protocol 6. Its then-new Mac worker and provider started
successfully and the user later reported slow fallback-row filling.

The protocol-4 supervisor and provider were stopped while the old durable
worker and its existing PTY were preserved. That session is not migrated
into the protocol-5 worker. Preservation details are in
`.pocket/retired-protocol4-daemon.json`; the new trace is
`.pocket/responsive-daemon.log`.
The native fixtures establish rendering behavior, not physical frame rate.

## Cached scrollback baseline

**This preceding revision added local inertial scrollback, a touchpad, right-nub
cursor arrows and three pixel fonts.** The user confirmed the preceding
paired-terminal build was usable, then identified slow scrollback and blurry
text. The results below distinguish the new revision from that physical
baseline. The synchronization mechanism is documented in
[SCROLLBACK.md](SCROLLBACK.md).

| Baseline check | Result |
| --- | --- |
| Guest and host types; unit suite | Passed: 50 tests, 1,432 assertions |
| Native Ghostty history and real provider/PTYS | Passed: 2 integrations, including pruning, same-chunk clear/refill, palette invalidation, reconnect and saved Vim/Nano cursor edits |
| All three generated atlases | Reproduction matched; ASCII is 1:1 source bitmap coverage with 5px advance |
| Production 3DS launcher/package | Built; expected app key path present and capture marker absent |
| macOS mirror | Guest and release desktop host built |
| Native font/layout frame | Inspected at 80×24; Spleentt, full-width last column and bottom touchpad |
| Native delayed-history frame 180 | Inspected: translated rows retain identity, missing rows show skeletons |
| Native settled-history frame 360 | Inspected: missing rows filled, consecutive row identities and the reading anchor preserved |
| Physical FTP deployment | Passed: production launcher and pairing key read back byte-identically on 2026-09-06 at 21:46 UTC |
| Physical revision acceptance | User confirmed Nano nub control worked; reported high latency, slow motion and noisy lower-screen controls |

[Native font/layout](terminal-80x24.png), [history while loading](history-loading.png),
[history after filling](history-settled.png), and
[font comparison at 1:1](font-comparison.png) are retained as review artifacts.
The font study compares the previous antialiased face with Spleen, Spleentt and
Fusion; the native fixture verifies the selected face through the 3DS renderer.
These deterministic emulator frames do not establish physical frame rate.

| Baseline artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| pocketterm-main.3dsx | 1,937,872 | `6f65c3a374681c1151175fc088e00ea8727df70c060e46a315f3a7d70f377c8f` |
| pocketterm-main.pocket | 635,416 | `fc3180add555cc7a5cf7136162a49f21007807650d2c411a36853cc82c1502c5` |

**The protocol-4 launcher was installed at `/3DS/pocketterm-main.3dsx`.**
The previous launcher was backed up and verified at
`/pocketjs/runtime/native-backups/pocketterm-main-9f4a08ce175b4af4.3dsx`.
Its FTP readback matched the baseline artifact above. The latest
`.pocket/last-deploy.json` now records the protocol-5 deployment.

After this baseline deployment, the Mac companion waited for the console
to leave ftpd. The previous provider was stopped while its durable terminal worker
and both existing PTYs were preserved for their original desktop mirrors.
Those sessions are not migrated into the new worker. Its new sessions use
terminal protocol 4. The baseline trace is `.pocket/cache-daemon.log`;
preservation details are in `.pocket/retired-protocol3-daemon.json`.

## Initial paired-terminal baseline


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
| Physical FTP deployment | Launcher and app-specific offload key uploaded; both read back byte-identically |
| Physical paired connection | Mac provider connected to the 3DS at TCP port 8741; the device sent `hello` and created an 80×24 zsh PTY |
| Physical input and multiplexing | Fresh character/key, new, kill, attach and scroll requests observed; three 80×24 PTYs created and repeated session switching recorded |

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

**Physical FTP deployment passed on 2026-09-06 at 17:49 UTC.** The launcher
above was installed at `/3DS/pocketterm-main.3dsx` through ftpd on
`192.168.8.102:5000`. Its app-specific key was installed at
`/pocketjs/offload/22a222ca7b6bddb1.key`. Both files were downloaded again
and compared byte-for-byte with their local originals. The previous launcher
was backed up and verified at
`/pocketjs/runtime/native-backups/pocketterm-main-1452e2723b5edc0f.3dsx`.
The local receipt is `.pocket/last-deploy.json`; it contains no key material.

**Physical launch, paired requests and fresh input passed.** The Mac provider
has an established connection from `192.168.8.159` to the console at
`192.168.8.102:8741`. Its trace records a device `hello`, an 80×24 zsh PTY,
character/key requests followed by shell prompt updates, two `new` requests,
one `kill`, 19 `attach` and 151 `scroll` requests by 17:54 UTC. Three 80×24
PTYs were created and the device attached to each. Desktop mirrors attach
through their session-specific loopback listeners. The local trace is
`.pocket/offload-daemon.log`; the acceptance snapshot is
`.pocket/last-hardware-run.json` and contains command kinds, not typed text.

The user subsequently confirmed that this build was usable and reported
scrolling and font quality as the main problems. HBL return was not separately
confirmed in that report. Device telemetry recorded a cumulative maximum CPU frame of
316,584 microseconds and 137 frames over 16ms in the first 4,827 frames;
the connection/input evidence does not establish consistently smooth frames.
The pinned offload host starts its embedded package without the legacy dev
server; hot push and dev-server screenshots are unavailable in this mode.
The previous FTP receipt in `RUNTIME-UPGRADE.md` belongs to the older
57×17 svc build.
