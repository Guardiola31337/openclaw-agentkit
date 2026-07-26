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
openclaw agentkit request --resource https://127.0.0.1:<port>/plugins/agentkit/external-verification/<token> --gateway-certificate-file <gateway-cert.pem> --private-key-file <path>
```

The plugin route creates the signed-resource challenge, verifies the returned
AgentKit header and AgentBook human lookup inside the running plugin instance,
then calls `completeExternalVerification(...)`. The ordinary approval RPC
remains deny-only. The route token is bound to one active attempt, disappears
on completion or abort, and never sends proof material into OpenClaw core.
When Gateway TLS is disabled, the generated resource uses loopback HTTP and
omits `--gateway-certificate-file`. With TLS enabled, that option is restricted
to the loopback resource and pins the exact configured Gateway leaf
certificate. A challenge cannot redirect the signed header to another URL.

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
World transport is mocked. The delegation lane starts a self-signed TLS Gateway
and proves the unsigned challenge, signed retry, and plugin-bound completion.

Run the complete local flow in one command:

```sh
pnpm test:local-full-e2e -- --openclaw ../openclaw
```

Use `--skip-host-build` when the linked checkout is already built. Keep the
manual production ceremony, redacted capture, and local secret mapping on the
implementation discussion rather than in the package source.

After OpenClaw publishes a compatible beta or stable release, replace the local
link with that package and update `package.json` compatibility metadata.
