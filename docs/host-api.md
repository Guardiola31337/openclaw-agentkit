# Required OpenClaw Host APIs

This package is intentionally outside OpenClaw core. It needs generic OpenClaw plugin host APIs so an external plugin can manage a protected-tool approval lifecycle without importing OpenClaw internals.

Upstream tracker: https://github.com/openclaw/openclaw/issues/82336

Current upstream split:

- https://github.com/openclaw/openclaw/pull/82431 exposes plugin approval actions and no-route pending approvals.
- https://github.com/openclaw/openclaw/pull/82434 exposes narrow verified plugin approval resolution.
- https://github.com/openclaw/openclaw/pull/82471 exposes durable `chat.inject` metadata and a narrow chat injection helper for approval-card retry prompts.
- https://github.com/openclaw/openclaw/pull/82752 lets local plugin approval gateway calls use the operator approval runtime token.

Until those PRs land, CI links against `Guardiola31337/openclaw@agentkit/external-plugin-host-apis`, a temporary branch that combines those host API changes for this external plugin.

## Required Surface

- `before_tool_call` result support for plugin-provided approval action descriptors, such as `Verify with World`.
- Pending plugin approvals that can stay pending without an active approval route.
- Verified approval resolution scoped to the originating plugin id.
- A narrow chat injection helper for trusted plugin approval/status prompts.
- Transcript injection metadata for approval-card retry prompts.
- Turn-source metadata propagation through the approval path so channel-originated approvals can return to the correct target.
- Local approval list/resolve/wait calls from the agent harness must be able to authenticate against the local gateway without exposing broad operator credentials to the plugin.

## Current Testing Strategy

Until those APIs ship in OpenClaw, test against an OpenClaw checkout that includes the API branch:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
pnpm test:hitl
pnpm test:openclaw-hitl
```

`test:hitl` covers the plugin's local HITL logic with mocked host dependencies. `test:openclaw-hitl` starts a real OpenClaw gateway, installs this checkout as an external plugin under a temporary OpenClaw state directory, runs the `before_tool_call` hook for protected tool `exec`, verifies the pending approval actions, denies the approval through `plugin.approval.resolve`, and asserts the hook blocks with `deniedReason: "plugin-approval"`.

Once OpenClaw publishes a compatible beta or stable release, replace the local link with the released `openclaw` package and update `package.json` compatibility metadata.
