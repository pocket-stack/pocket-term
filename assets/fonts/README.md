# Terminal bitmap fonts

**The upstream BDF bytes are preserved in gzip archives.** Compression uses
level 9 with no filename or timestamp in the header (`gzip -n -9`). The three
sources occupy 353,333 bytes compressed instead of 3,303,564 bytes of text.
The build tools and Mac rasterizer decompress them through
`shared/font-sources.ts`; the 3DS receives baked atlases. Regenerate the app's
three terminal atlases with `bun scripts/font.ts` and verify reproduction
with `bun scripts/font.ts --check`.

| Face | Pinned source | License |
| --- | --- | --- |
| Spleen 5×8 | [fcambus/spleen](https://github.com/fcambus/spleen/tree/57f9219328c9f5873085320fe8bc8f7dd34b8791), version 2.2.0 | BSD-2-Clause, `spleen/LICENSE` |
| Spleentt 5×8 | [tommythorn/spleentt-5x8-font](https://github.com/tommythorn/spleentt-5x8-font/tree/54f98cef28e7e5c656414e8854d9986a8e7cb89d) | BSD-2-Clause, `spleentt/LICENSE` |
| Fusion Pixel 10px Monospaced, Simplified Chinese | [TakWolf/fusion-pixel-font release 2026.09.01](https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.09.01), BDF release archive | SIL OFL 1.1, `fusion-pixel/OFL.txt` and upstream component notices in `fusion-pixel/LICENSES/` |

The hashes below identify the **decompressed, unmodified source bytes**.
For example, `gzip -dc assets/fonts/spleen/spleen-5x8.bdf.gz | shasum -a 256`
checks the Spleen source. The adjacent license files remain readable text.

| Source | SHA-256 |
| --- | --- |
| Spleen | `40488184d075d0c752cdd239b441c5ece51e50b353156f2496c756c384ab01cb` |
| Spleentt | `8503def0ec91e7aa54f6a067acb181b843904c6bf37207d80fa6d095adc46304` |
| Fusion Pixel | `fb35066c7ade4b9674abb3e528d9adc82f6a2c359902e567ef8bead3621c5d4e` |

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
