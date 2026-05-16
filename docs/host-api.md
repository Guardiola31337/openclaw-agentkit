# Required OpenClaw Host APIs

This package is intentionally outside OpenClaw core. It needs generic OpenClaw plugin host APIs so an external plugin can manage a protected-tool approval lifecycle without importing OpenClaw internals.

Upstream tracker: https://github.com/openclaw/openclaw/issues/82336

## Required Surface

- `before_tool_call` result support for plugin-provided approval action descriptors, such as `Verify with World`.
- Pending plugin approvals that can stay pending without an active approval route.
- Verified approval resolution scoped to the originating plugin id.
- Operator-admin gateway helpers for trusted plugin flows.
- Transcript injection metadata for approval-card retry prompts.
- Turn-source metadata propagation through the approval path so channel-originated approvals can return to the correct target.

## Current Testing Strategy

Until those APIs ship in OpenClaw, test against an OpenClaw checkout that includes the API branch:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
```

Once OpenClaw publishes a compatible beta or stable release, replace the local link with the released `openclaw` package and update `package.json` compatibility metadata.
