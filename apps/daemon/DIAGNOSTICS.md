# Diagnostics export

Diagnostics are manual and stay on the machine. The automatic fault-upload pipeline
is removed with telemetry: nothing collects incidents in the background and nothing
uploads them. See `PRIVACY.md`.

## Surfaces

Both surfaces call `GET /api/diagnostics/export`:

- the web UI's export action, which saves through the browser or the desktop's native
  save dialog;
- `od diagnostics export [<path>] [--json]`.

## Contents

`apps/daemon/src/diagnostics-export.ts` builds the bundle from what the daemon can read:
app logs, crash reports, environment evidence, recent API failures, and runtime health.
`packages/diagnostics` owns log collection, redaction, manifests, crash-report discovery,
and zip packaging. Text is redacted before it is packaged. The manifest reports missing
or truncated sources instead of omitting them silently.

`apps/daemon/src/diagnostics-client-evidence.ts` holds evidence that lives only in the
renderer, such as the chat scroll forensics posted to
`/api/diagnostics/chat-scroll-forensics`. It is memory-only and drains into the next export.

All daemon-owned paths derive from the resolved data root; see the root `AGENTS.md`
**Daemon data directory contract** for ownership and launch propagation.
