# Input and scrolling responsiveness

**Input is separate from screen delivery since protocol 5.** Protocol 6 adds
[batched history reads](HISTORY-THROUGHPUT.md). `term.input` has one
request in flight, containing up to eight ordered commands that fit the
PocketJS offload record budget. `term.exchange` independently pulls screen
fragments. A held output reply cannot prevent a new key from reaching the
Mac. Retried commands retain their ids; a restarted delivery epoch discards
uncertain input and cancels old tickets. A late callback from an older epoch
cannot restore it.

The 64-command queue remains bounded. A batch is admitted before sending any
of it, and ids are validated before executing new commands. The Mac consumes
rejected commands once and retains an error across subsequent commands in
the same batch. **Key repeat does not drop or merge logical keystrokes.**

Output fragments fit their actual nested JSON encoding, up to 1,800 UTF-16
code units instead of a fixed 600. Both the payload and UTF-8 record limits
are checked, including escaped quotes and surrogate pairs. Held output
reserves room for acknowledgement growth and a later input error. Atlas pieces
are 1,536 base64 characters; changed screen rows take precedence over the
next atlas piece. History starts pause while input is pending. These changes
use the existing bounded offload queues and worker, with no socket work on
the 3DS UI thread.

## Local motion

**The history planner runs on viewport demand changes, not every frame.**
It uses the public PocketJS `createResourceScheduler`, preserving bounded
requests, materialization, cancellation and eviction. The app plans in
eight-row buckets with enough pinned rows to cover the viewport through the
bucket. Manifest and direction changes also replan. Per-slot signals publish
only relevant cached-row changes; the scheduler still advances once per
frame so completion and retry timing remain deterministic.

The canvas and recycled row positions use paint translations. Text and row
geometry are not rounded to ten-pixel steps. Pixel rounding preserves bitmap
font sharpness while allowing one-pixel motion. A normal full stick deflection
advances the target by 18px per frame; release carries its velocity into the
same kinetic fling used by the touchpad. Opposite motion cancels the old
chase target. The viewport clamps at terminal history boundaries. Settings
also offers a 1.5× speed option. Touch drag gain is 3× and release velocity is
bounded to 4,800 logical pixels per virtual second.

Keyboard pressed-state memos stop a changed key from rewriting every other
key's style. The four touch arrow keys are removed; the hardware D-pad and
right nub retain that function. Font, preview and speed controls live in a
settings panel. The normal lower screen has session tabs, a touchpad, a small
connection indicator and the keyboard.

## Provisional echo

**Prediction changes only a display overlay.** The authoritative grid,
scrollback and PTY input remain unchanged. Pending text is underlined until
confirmed. Matching real output replaces it; a mismatch clears it.

The implementation learns each kind of action from two matching echoes
before displaying predictions. It supports single printable ASCII characters
appended in blank row space and learned cardinal cursor movements within
known ASCII rows. It does not predict a row wrap, wide glyph, control key,
paste, completion or command execution. Empty right-hand space is required
for text; it does not guess an editor's insertion or overwrite mode.

A grid carries the input acknowledgement at snapshot creation. **An accepted
PTY write alone is not proof of application echo.** Confirmation additionally
requires matching cells and cursor. An unchanged pre-input screen waits until
the first frame past 350ms of virtual time; unknown or mismatched output
revokes the prediction. At most 16 hypotheses are retained, and learned
confidence stops enabling previews after two virtual seconds without
confirmation. Session/screen transitions, disconnects, resyncs and
unmodeled keys reset confidence. A silent password-like input path never
trains echo. Settings can disable the preview.

**Prediction reads the framework's `virtualNow()` clock in production and
tests.** The framework advances this clock once at the start of each frame;
input, authoritative confirmation and expiry in that transaction observe
the same time. The store converts virtual seconds to milliseconds for the
prediction model. Host-selected simulation rates retain the same time units.
`Date.now()` would introduce unrecorded UTC time into replica state;
`performance.now()` would still introduce unrecorded real elapsed time.

These deadlines bound display hypotheses in simulation time. Pausing the
frame pump pauses them, and running below the simulation rate extends their
real duration. A requirement to expire after real elapsed time needs a host
monotonic deadline delivered as a recorded event at a frame boundary. Network
deadlines remain transport concerns; this display policy does not extend them.

This follows the observed-echo approach described by
[Mosh](https://mosh.org/#techinfo). Warp instead describes
[a command editor owned by the terminal](https://www.warp.dev/blog/why-is-the-terminal-input-so-weird),
which submits its completed buffer to the shell. Pocket Term retains the
PTY's incremental input contract so Nano, Vim and other foreground programs
continue to decide what keys mean.

## Validation and limits

The deterministic latency fixture simulates a 60Hz native frame boundary,
100ms round trips, two submissions and one reply delivery per frame. It sends
60 keys at 20Hz, measures arrival at the PTY capability, and checks order and
uniqueness. The baseline is the previously deployed `c2b7d0e` guest transport.

| Simulated input arrival | Previous transport | Protocol 5 |
| --- | ---: | ---: |
| P50 | 2,083ms | 133ms |
| P95 | 3,883ms | 183ms |
| Maximum queued keys | 35 | 4 |
| Received keys | 60, in order | 60, in order |

This measures queue behavior under the stated conditions, not physical
3DS network latency. `test/latency.test.ts` pins the new transport's queue
bound and 200ms P95 ceiling for this fixture. `test:pty` exercises the actual
Bun provider and Node broker, including batched right-nub keys, lost-reply
retries and saved files in Vim and the system Nano/Pico.

A desktop Bun sample of 1,000 idle history frames with 144 loaded rows took
61.15ms before and 3.11ms after. The repeatable invariant is **zero demand
replans while idle**, tested directly; those desktop times do not predict
3DS frame rate. Prediction tests cover confirmed prefixes, mismatches,
timeouts, control transitions, non-echoing input and cell preservation. Store
tests drive the framework clock at 20Hz and 60Hz with wall-clock reads forbidden,
checking preview expiry, confidence age and preservation of authoritative cells.

Native fixtures are built with `bun run visual --history --motion`,
`--settings` and `--preview`. They use the actual 3DS renderer, delayed mock
replies and the same framework clock as production, with no fixture-specific
prediction clock. The emulator's wall-clock speed does not consume the
preview deadline.

[Settings](responsive-settings.png), [provisional echo](responsive-preview.png)
and [six consecutive motion frames](responsive-motion.gif) retain the pixels.
The echo frame shows the third `a` and its five-pixel underline before its
mock reply, while the authoritative grid still contains `$ aa`. Motion
frames 181–184 translate unchanged row pixels by 12, 11 and 10px respectively;
other frames also fill delayed rows. The GIF plays slowly for inspection.
The user accepted the deployed protocol-6 build after the virtual-clock
update. Numerical physical latency and frame-rate measurements remain
separate from these simulated and native-fixture results.
