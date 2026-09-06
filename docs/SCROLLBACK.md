# Local terminal history

**The Mac owns terminal state; the 3DS owns its reading position.**
libghostty parses PTY output in the durable Node session process. The live
80×24 screen still arrives as an ordered, atomically committed grid. The
device does not replay terminal escape sequences or mutate cached history.

Pocket Doc's bounded resource views and Pocket Map's local scrolling inform
the device implementation: `createScroller` advances the viewport, while a
resource collection fetches only demanded rows. Both APIs come from the
pinned PocketJS main. No unmerged framework code is copied into this app.

## Row identity and synchronization

Each committed live grid includes `{epoch, first, end, alternate}`. Historical
rows occupy the half-open range `[first, end)`; live row `y` follows at
`end + y`. A cache key contains the session id, history epoch and absolute
row number. **Appending output never changes an existing historical key.**

Ghostty's history accessor is newest-first. Its discarded-row counter plus
retained count establishes absolute addresses; the Mac reads row `r` at
`end - 1 - r`. Tests use the pinned native core, including its page-based
pruning, rather than assuming its configured limit is an exact row count.

| Change | Device behavior |
| --- | --- |
| Output appended while following live | Move to the new live screen |
| Output appended while reading history | Preserve the absolute reading position; new output remains below |
| History pruned | Retain surviving row identities, rebase the scroll origin, clamp an expired position to the oldest available row |
| Clear history, terminal reset, resize or alternate-screen transition | Change epoch, cancel stale loads and return to the current live screen |
| Provider disconnected | Keep cached rows and the last live screen, mark the view offline, stop new reads |
| Same session reconnects | Adopt the current manifest; preserve valid history and the reading anchor |
| Terminal process/replica restarts | Discard uncertain input and cached delivery state; accept a fresh manifest |
| Session switched | Fence pending reads and hide the previous session's live grid |

**An epoch fence also covers clear-and-refill in one PTY chunk.** A small
observer recognizes destructive VT boundaries across split chunks and
ignores escape-looking data in OSC/DCS strings. It does not interpret cells;
Ghostty remains the parser. Checking counts only after parsing would miss a
clear followed by enough output to reuse old indices with a larger count.

`term.history` is a read-only offload method, separate from the ordered
`term.exchange` input stream. Every fragment repeats the epoch and row
identity. The server rejects expired ranges; the client checks fragment
order, identity and size and fences late completions after cancellation.
A missing row is a skeleton; an empty decoded row is a known blank.

## Frame and memory bounds

The top screen has **26 reusable row slots** for 24 visible rows and two
edge rows. Crossing one row reassigns one slot. Sub-row motion writes a
rounded pixel translation through PocketJS's hot property API, so neither
network round trips nor rebuilding all rows drives motion. The render
origin rebases every 512 absolute rows to keep native float coordinates
small. Left-stick nudges and lower-screen drag/flick share this scroller.
Typing and cursor keys return to live; alternate screens disable history.

| Budget | Limit |
| --- | ---: |
| Exposed Mac history | At most 2,000 rows per session |
| Device resident cache | 192 entries, each conservatively charged 64 KiB |
| Current demand | 144 rows, visible rows pinned first |
| Directional lookahead | Approximately 3:1 ahead versus behind |
| History requests in flight | 2 |
| Starts / materializations | At most 1 of each per frame |
| Response fragment | 600 UTF-16 code units |
| Serialized row | 16,384 UTF-16 code units |
| Read retries | 3 attempts, 45–180 frame backoff |

The cache is in RAM and is not persisted to the SD card. Revisiting an
evicted row needs the Mac; disconnected cache misses remain skeletons.
Failed reads use a distinct skeleton color and bounded retries.

## Glyph residency

**A cached Unicode row does not imply its bitmap is still resident.**
The device tracks the codepoints in each loaded atlas. It draws a historical
row only when all its dynamic glyphs are available; otherwise it shows the
skeleton while requesting visible glyph residency. Prefetch reads classify
glyphs without placing them in the atlas, so distant rows cannot evict the
current viewport's glyphs merely by downloading.

Visible interest is sent as an ordered, bounded batch and published on the
Mac only when complete. A face retains up to 1,024 dynamic glyphs. Idle
replicas stop requesting residency after 15 seconds. Several simultaneously
active replicas can still contend for that finite atlas; this is not an
unbounded Unicode cache. ASCII and terminal furniture live in the shipped
static atlas and need no residency requests.

## Validation

`bun run check` exercises the actual PocketJS resource runtime with delayed
replies, cancellation, offline reading, append/prune anchors and slot reuse.
`bun run test:pty` covers native Ghostty history identities and reads through
the actual Bun provider/Node PTY path, including reconnect and expiration.
It also feeds right-stick-generated arrow keys into `/usr/bin/vim` and
`/usr/bin/nano` and checks the saved text. On this Mac, `nano` identifies as
Pico. This proves escape/input behavior, not the physical nub's feel.

`bun run visual --history` builds a separate native capture fixture. It
injects analog input while history replies arrive with variable frame
delays. Add `--frame=360` to capture after the visible rows have filled.
`bun run visual` builds the static 80-column font/layout fixture.
Neither fixture is a production launcher or evidence of physical frame rate.

[Superlogical's public material](https://www.superlogical.com/) describes durable sessions, native history
and reconnecting from other devices. It does not specify a reusable public
cache protocol; the identities and invalidation rules above follow the
terminal core's concrete behavior.
