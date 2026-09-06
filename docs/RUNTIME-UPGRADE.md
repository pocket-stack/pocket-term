# Runtime upgrade validation

Validated on 2026-09-06 against PocketJS main
`10aee589d95aca34802ea4f8c79023e929434a92`.

The runtime includes the current HBL icon assets, per-app recovery storage,
L+R+START exit, and the merged 3DS companion transport. Its shared socket
service also supports Pocket Doc's offload worker.

- `bun run check`: TypeScript plus 31 host tests passed (77 assertions).
- `bun run 3ds`: full ARM build passed using the pinned runtime and toolchain.
- Both embedded SMDH icons (24×24 and 48×48) match the already hardware-accepted Pocket Doc package byte for byte. Decoded RGB565 pixels were visually checked.
- The rebuilt `/3DS/pocketterm-main.3dsx` was uploaded over FTP and read back byte for byte. Its isolated runtime slot had no staged or active replacement packages, so the next launch uses the newly embedded guest.

The actual 3DS `svcwire.c` was also compiled on macOS with socket-service stubs under ASan/UBSan and connected over loopback TCP to the Node companion. The PKNT handshake, PTY command output and streamed CJK glyph atlas passed. The device-facing daemon now advertises to the current console address. This checks the transport code against the real daemon; it does not exercise libctru sockets on hardware.

| Artifact | Value |
| --- | --- |
| 3DSX bytes | 1852228 |
| 3DSX SHA-256 | `1452e2723b5edc0ff7a3b97a6cdcfb2b303f679e5500d90eff2d340be5daaba1` |
| Combined SMDH icon SHA-256 | `d2f5674914634ba7b99ffe222fef9e7905692e59c22e125f4a18c946df479f07` |

**Fresh physical interaction with this Pocket Term build is pending.** FTP
readback confirms the installed bytes; it does not confirm a new HBL launch
or input handling. The earlier Pocket Doc hardware acceptance is separate.
