# Required OpenClaw Host APIs

AgentKit remains outside OpenClaw core. It uses the generic, plugin-bound
external verification contract accepted in
[openclaw/rfcs#15](https://github.com/openclaw/rfcs/pull/15).

Implementation and runtime proof are tracked in
[openclaw/openclaw#82336](https://github.com/openclaw/openclaw/issues/82336).

## Required surface

The plugin requires these OpenClaw contracts:

- A `before_tool_call` approval may declare
  `externalResolution: { label, decisions? }`. The hook does not supply
  `pluginId`; OpenClaw stamps plugin, run, tool, session, and approval identity.
- Generic resolution remains deny-only while an external verifier owns the
  allow path.
- `api.approvals.onExternalVerification(handler)` registers exactly one verifier
  for the plugin.
- The handler receives an immutable attempt context, an `AbortSignal`, and
  `present(...)`. It presents the challenge, starts cancellable verification
  work, and returns without holding the host dispatch path open.
- `api.approvals.completeExternalVerification(...)` completes only an attempt
  owned by the calling plugin. Completion is idempotent and first-answer-wins
  with deny, timeout, cancellation, and shutdown.
- Successful `allow-always` completion may return a stable
  `grantAuthorization`. `api.approvals.openGrantStore()` provides bounded
  plugin-owned storage for that authorization and its tombstones.
- The canonical text command binds the approval, reviewer, decision, plugin,
  run, and message interaction before dispatch. Redelivery reuses the attempt;
  a newly sent command is an explicit retry.

The command does not expose a plugin resolver. Gateway callers cannot claim a
plugin identity or complete an attempt, and the plugin cannot resolve an
approval through the ordinary public approval RPC.

## Approval controls

OpenClaw renders these canonical commands. The first line is
`Verify with World` in `human-approval` mode and
`Verify AgentKit delegation` in `delegation` mode:

```text
<plugin verification label>
Verify once: `/approve plugin:<id> external allow-once`
Verify and trust for session: `/approve plugin:<id> external allow-always`

Deny: `/approve plugin:<id> deny`
```

Repeating the same command interaction replays its immutable result. Sending
the command from a new interaction creates a fresh attempt and cancels any
active attempt for that approval. A stale retry cannot cancel a newer attempt.

## Delegation ceremony

Delegation mode uses the same host-bound attempt contract. After the reviewer
sends the canonical command, AgentKit presents a one-use loopback resource
command:

```sh
openclaw agentkit request --resource http://127.0.0.1:<port>/plugins/agentkit/external-verification/<token> --private-key-file <path>
```

The plugin route creates the signed-resource challenge, verifies the returned
AgentKit header and AgentBook human lookup inside the running plugin instance,
then calls `completeExternalVerification(...)`. The ordinary approval RPC
remains deny-only. The route token is bound to one active attempt, disappears
on completion or abort, and never sends proof material into OpenClaw core.
Delegation verification currently requires Gateway TLS to be disabled; the
plugin fails closed during attempt setup when TLS is enabled. TLS support can
follow as a separate transport change.

`openclaw agentkit approve` remains available for denial and compatibility
guidance, but it cannot submit an allow decision.

Approval lookup and denial use OpenClaw's configured Gateway URL and
credentials. An explicit `--gateway-url` must be paired with
`--gateway-token`; prefer configured credentials or environment indirection so
secrets do not appear in the process list.

## Grant contract

AgentKit persists only host-authorized grant metadata:

- stable grant authorization id and issue time;
- originating approval and attempt ids;
- exact protected tool;
- exact session key and ephemeral session id;
- expiry and terminal status.

It does not persist World proof material or proof nullifiers. Expired, revoked,
consumed, and reset grants become terminal tombstones and cannot be recreated
from a replayed completion. Reset boundaries include explicit `new`/`reset`,
automatic `idle`/`daily` rollover, and session deletion; compaction and Gateway
restart/shutdown do not revoke an otherwise valid grant.

## OpenClaw 2.0 host behavior

The contract above is unchanged on OpenClaw 2.0 (2026.8.1); the plugin runs
unmodified. The 2.0 host adds two behaviors to the same contract and changes
internals that only host-slice authors need to know.

Contract additions:

- **Session-grant coverage.** When an `allow-always` completion mints a grant,
  the host resolves approvals already pending that match the grant predicate
  exactly (owner plugin, tool, session key, ephemeral session id, unexpired,
  `allow-once` offered). Each covered approval is recorded in the attempts
  ledger as a synthetic succeeded attempt with terminal source
  `session-grant-covered`; its interaction id is the recomputable sha256 of the
  grant authorization id and the approval id. Reviewers complete one ceremony
  for a session, including calls that raced the scan.
- **Ceremony pinning.** Run-end cleanup spares an approval whose external
  verification attempt is live in the host process, so a reviewer's in-flight
  challenge stays valid when the model abandons the blocked call. The
  abandoned call never executes; the approval's own expiry still bounds the
  pin. Policy-driven closures (permission change, scope closed, worker
  fencing) and Gateway shutdown still cancel fail-closed.

Host internals that moved under the contract (slice authors only):

- Approval ownership is derived from the signed agent runtime identity; the
  public payload never carries `pluginId`. Internal approval-runtime callers
  are the only source of `externalResolution`, `runId`, and `sessionId`.
- Runs execute hooks from per-run plugin generation registries loaded in
  discovery mode; the `api.approvals` surface is served to every registration
  mode that can register hooks.
- `operator_approvals.resolution_ref` is a reserved canonical approval
  identifier and cannot carry grant linkage; the attempts ledger is the audit
  surface for ceremonyless authorization.
- The attempts table ships as a same-version additive SQLite table with a
  first-use ensure, per the 2.0 schema doctrine.
- The 2.0 standing-grant ledger is a separate authority for cron/exec
  approvals; external verification grants stay in the plugin-owned grant
  store and never mint standing grants.

## Reviewer surfaces

The TUI is the reference reviewer surface: approval card with the external
choices and deny focused, one ceremony presented at a time, card dismissed
once a challenge dispatches, challenge text and canonical commands in the
chat log.

Web and native reviewer support follows the same ownership split the RFC
agreed on: the plugin owns what is presented, core surfaces own how. The
plugin will emit surface-neutral presentation parts (challenge payload, link,
text) alongside today's terminal text; each core surface renders parts
natively (terminal QR, web image QR, native QR views) without learning any
World semantics. Core keeps zero World-specific behavior; everything above
the generic parts contract stays in this plugin.

## Test against a source checkout

Until the API ships in an OpenClaw release, link a compatible checkout:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
pnpm test:hitl
pnpm test:openclaw-hitl
```

`test:hitl` proves the plugin contract with deterministic host, AgentKit, and
World fixtures. `test:openclaw-hitl` builds an isolated state directory,
installs this checkout as an external plugin, starts a real built OpenClaw
Gateway, and drives the real approval broker plus `before_tool_call` hook. Only
World transport is mocked. The delegation lane proves the unsigned challenge,
signed retry, and plugin-bound completion over loopback HTTP.

Run the complete local flow in one command:

```sh
pnpm test:local-full-e2e -- --openclaw ../openclaw
```

Use `--skip-host-build` when the linked checkout is already built. Keep the
manual production ceremony, redacted capture, and local secret mapping on the
implementation discussion rather than in the package source.

After OpenClaw publishes a compatible beta or stable release, replace the local
link with that package and update `package.json` compatibility metadata.
