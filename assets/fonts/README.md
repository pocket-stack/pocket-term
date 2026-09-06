# Terminal bitmap fonts

These source files are copied without modification. Regenerate the app's
three terminal atlases with `bun scripts/font.ts` and verify reproduction
with `bun scripts/font.ts --check`.

| Face | Pinned source | License |
| --- | --- | --- |
| Spleen 5×8 | [fcambus/spleen](https://github.com/fcambus/spleen/tree/57f9219328c9f5873085320fe8bc8f7dd34b8791), version 2.2.0 | BSD-2-Clause, `spleen/LICENSE` |
| Spleentt 5×8 | [tommythorn/spleentt-5x8-font](https://github.com/tommythorn/spleentt-5x8-font/tree/54f98cef28e7e5c656414e8854d9986a8e7cb89d) | BSD-2-Clause, `spleentt/LICENSE` |
| Fusion Pixel 10px Monospaced, Simplified Chinese | [TakWolf/fusion-pixel-font release 2026.09.01](https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.09.01), BDF release archive | SIL OFL 1.1, `fusion-pixel/OFL.txt` and upstream component notices in `fusion-pixel/LICENSES/` |

**ASCII advances 5px in all three terminal atlases.** Spleen and Spleentt
retain their original 5×8 pixels with padding inside a 5×10 cell. Fusion
uses its original 10px height; its ASCII advances 5px and CJK advances 10px.
There is no resampling or antialiasing of these bitmap glyphs. Spleentt is
the default; open settings on the lower screen to compare the faces.

The generated atlas is a product composition: ASCII comes from the selected
face, other narrow symbols prefer Fusion, and terminal box/block glyphs are
drawn procedurally to meet the 5×10 cell edges. A symbol absent from both
bitmap sources uses a thresholded JetBrains Mono outline. JetBrains Mono's
SIL OFL notice is retained in
`vendor/pocketjs/assets/fonts/LICENSE-JetBrainsMono.txt`.

**Dynamic CJK is baked on the Mac from Fusion at 1:1 pixels.** Each glyph
keeps its terminal column width even when narrow and wide characters share
an atlas. Characters outside Fusion's coverage use the existing system-font
fallback chain; those outline fallbacks can still use antialiasing.
