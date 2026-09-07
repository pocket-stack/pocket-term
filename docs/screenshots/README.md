# Current interface captures

**These PNGs come from Pocket Term's native 3DS renderer in Azahar.** They use
the production UI and framework clock with deterministic example shell data
from `test/fixtures/screen.tsx`. They are not photographs or live shell traces.

[captures.json](captures.json) records the runtime pin, fixture hash, commands,
dimensions and image hashes used for this capture set.

| File | Content | Native dimensions | Build command |
| --- | --- | --- | --- |
| [terminal.png](terminal.png) | Shell, session tabs, touchpad and keyboard | 400×240 top screen; centered 320×240 lower screen | `bun run visual --showcase` |
| [settings.png](settings.png) | Font, preview and scroll-speed settings | 320×240 lower screen | `bun run visual --showcase --settings` |

Both builds capture frame 40 using the separate `pocketterm-qa.3dsx` launcher.
Run that launcher in Azahar with a writable SD-card directory. The capture
appears under `pocketjs-captures/` as `f0040.raw` and `aux-f0040.raw`; `done`
indicates completion and `error.txt` reports a capture failure.

Decode the column-major, vertically inverted ABGR capture at its native size.
The combined terminal PNG centers the lower screen beneath the top screen
with 40px side margins. Pixels are not filtered or rescaled. The settings PNG
contains only the lower-screen capture.

These captures replace the earlier README interface images. The diagnostic
screenshots linked from [upgrade history](../OFFLOAD-UPGRADE.md) retain their
original revision context. [Batched history motion](../history-batched.gif)
and [provisional input](../responsive-preview.png) document those mechanisms
using their dedicated fixtures.
