# History throughput

**The previous cache requested and published one row at a time.** Its two
in-flight requests could fetch roughly 20 short rows per second at 100ms
round-trip latency. A normal 80-column row left most of each reply unused.
Rows over 600 UTF-16 code units required additional serial requests. The
resource scheduler then materialized at most one row per frame. Faster
Wi-Fi cannot remove those application-level waits.

**The pinned offload host delivers one record per UI frame.** Both
`framework/src/offload.ts` and `hosts/3ds/src/offload.c` enforce this limit.
The record cap is 4,096 bytes and the payload cap is 2,500 code units. At
60fps the record ceiling is 245,760 bytes/s (240 KiB/s), before JSON overhead
and competing screen/input replies; at 20fps it is 80 KiB/s. The current API
therefore cannot expose a 1 MB/s link to guest JavaScript. This is a bound
derived from the checked-in code, not a measurement of the radio.

The old `/history` handler also scheduled a live-screen scan after each
read. Reading immutable history does not change the terminal. The new batch
handler omits that scan.

## Grouped transport, individual cache ownership

Protocol 6 adds `term.history.batch`. The scheduler admits up to 32 pending
row loads, and the app groups up to 16 compatible row addresses into each of
two network requests. The Mac fills the actual nested JSON record budget
with complete rows. A single oversized row uses exact-offset fragments;
ordinary rows do not incur a continuation just to fill the last bytes of a
packet. Unicode surrogate pairs stay together.

**Cache identities remain session, history epoch and absolute row number.**
Transport batches do not create page identities. The Mac validates every
requested address before reading cells, so a pruned or expired range cannot
silently supply replacement rows. The guest validates every returned chunk
before completing any row in that envelope. Cancelling one row leaves its
peers usable; cancelling every row cancels the shared ticket. Late callbacks
cannot publish into a retired session or epoch. Appending history preserves
the meaning of already requested addresses, including a short newest tail.

Input retains its independent ordered ticket. History starts and
continuations pause while input is pending. The public resource scheduler
still owns retry, cancellation, eviction and materialization. The product
loader feeds it **at most eight rows and 4,096 serialized code units per
frame**. A single larger row may progress on its own. This text budget stops
a dense ANSI reply from creating hundreds of text nodes in one frame.
Resident entries remain capped at 192; demand remains capped at 144.

## Measurements

The replay uses the actual guest offload pump, two submissions and one
delivery per frame, 100ms simulated round trips, continuous idle screen
polls and a cold 26-row viewport. Plain rows contain 80 characters. The dense
case changes color every character. The baseline is `d12e905`.

| Cold viewport | Previous | Batched |
| --- | ---: | ---: |
| Plain, 60fps: all 26 rows ready | 1,550ms | 167ms |
| Plain, 20fps: all 26 rows ready | 2,050ms | 300ms |
| Dense ANSI, 60fps: all 26 rows ready | 4,583ms | 1,867ms |
| Plain: maximum rows in one reply | 1 | 16 |
| Plain: maximum rows published in one frame | 1 | 8 |

The first plain row still arrives after 117ms at 60fps: batching reduces the
wait for the remaining rows, not the first network round trip. The trace
counts 27 history requests before the old viewport is complete and four for
the new one, including speculative lookahead. Consequently total bytes at
that point can increase: the new cache has fetched more future rows.

The actual Bun provider, Node broker and libghostty integration read the
same 26 `row-NNN` PTY history rows with 26 calls in 17.21ms, versus two calls
in 1.79ms. This is a local loopback sample, not Wi-Fi latency. The test also
checks identical rows after appends, lost replies/provider reconnection and
epoch expiration. The timing itself is not a flaky test assertion.

```sh
git show d12e905:app/history.ts > .pocket/before-batch-history.ts
bun --conditions=browser scripts/history-bench.ts --baseline=.pocket/before-batch-history.ts
bun run check
bun run test:pty
bun run visual --history --motion
```

The same native motion fixture at frame 182 previously showed two cached
rows among skeletons. The batch version shows consecutive rows across the
visible viewport. Compare [previous frame](history-single-row.png) with
[batched frame](history-batched.png); [six native frames](history-batched.gif)
retain pixel motion. These are deterministic emulator captures with delayed
mock replies, not physical frame-rate measurements.

**Physical bandwidth saturation is not claimed.** macOS denied access to
the BPF capture device, so no packet-level radio trace was obtained. A higher
bulk-transfer ceiling would require an upstream PocketJS change with bounded
byte/time budgets and UI-frame measurements. This revision removes the
terminal's small-row request bottleneck within the existing host contract.
