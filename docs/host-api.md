# Required OpenClaw Host APIs

This package is intentionally outside OpenClaw core. It needs generic OpenClaw plugin host APIs so an external plugin can manage a protected-tool approval lifecycle without importing OpenClaw internals.

Upstream tracker: https://github.com/openclaw/openclaw/issues/82336

Current upstream shape:

- https://github.com/openclaw/openclaw/pull/82434 exposes a narrow plugin approval external-verification command template and verified plugin-owned approval resolution.

Already on OpenClaw `main`:

- https://github.com/openclaw/openclaw/pull/83433 lets local plugin approval gateway calls use the operator approval runtime token. https://github.com/openclaw/openclaw/pull/82752 was closed as already implemented by that mainline work.

Paused follow-up:

- https://github.com/openclaw/openclaw/pull/82471 proposed durable `chat.inject` metadata/status cards. The current AgentKit end-to-end path no longer requires it; retry/status prompts render as text unless maintainers ask for a narrower durable-card follow-up.

Until the host API lands, CI links against `Guardiola31337/openclaw@agentkit/external-plugin-host-apis-main`, a temporary branch with the required host API change for this external plugin on top of current `main`.

## Required Surface

- `before_tool_call` result support for one plugin-provided external verification command template, such as `/agentkit approve {id} {decision}`.
- Core-generated approval controls for normal decisions, with AgentKit using `allowedDecisions: ["deny"]` so core stays the approval owner for rejection.
- Verified approval resolution scoped to the originating plugin id.
- Local approval list/resolve/wait calls from the agent harness can authenticate against the local gateway without exposing broad operator credentials to the plugin. This is now covered by OpenClaw `main`.

## Current Testing Strategy

Until those APIs ship in OpenClaw, test against an OpenClaw checkout that includes the API branch:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
pnpm test:hitl
pnpm test:openclaw-hitl
```

`test:hitl` covers the plugin's local HITL logic with mocked host dependencies. `test:openclaw-hitl` starts a real OpenClaw gateway, installs this checkout as an external plugin under a temporary OpenClaw state directory, runs the `before_tool_call` hook for protected tool `exec`, verifies the pending external verification command and core deny command, rejects one approval through `plugin.approval.resolve`, then resolves another through `plugin.approval.resolveVerified` and confirms the protected call continues.

From this source checkout, run the full local flow in one command:

```sh
pnpm test:local-full-e2e -- --openclaw ../openclaw-agentkit-host-apis-clean
```

Use `--skip-host-build` when the linked OpenClaw checkout is already built.

Once OpenClaw publishes a compatible beta or stable release, replace the local link with the released `openclaw` package and update `package.json` compatibility metadata.
