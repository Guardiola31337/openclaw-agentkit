# OpenClaw AgentKit

World AgentKit-backed human-in-the-loop approvals for OpenClaw protected tools.

This is a community ClawHub package published as `@guardiola31337/agentkit`. It was extracted from the OpenClaw AgentKit prototype in `openclaw/openclaw#78583` so the integration can live outside OpenClaw core. The host/plugin contract follows the accepted external verification design in `openclaw/rfcs#15`.

## Status

- ClawHub package: `clawhub:@guardiola31337/agentkit`
- Current version: `2026.5.16-beta.2`
- Channel: community beta
- Accepted design RFC: `openclaw/rfcs#15`
- Upstream API tracker: `openclaw/openclaw#82336`

The package depends on generic OpenClaw host APIs for external approval plugins. Until those APIs are available in an OpenClaw release, test this plugin against an OpenClaw checkout that includes the approval APIs listed in `docs/host-api.md`.

## What It Does

- Registers the `agentkit` OpenClaw command.
- Adds a `before_tool_call` hook that can pause configured tools.
- Delegates only the allow decision to a plugin-owned verification ceremony:
  World QR/link verification in `human-approval` mode, or a one-use signed
  AgentKit resource in `delegation` mode.
- Keeps denial, timeout, cancellation, retry, and approval identity host-owned.
- Stores proof-free, exact-session grants for `allow-always`.
- Tombstones grants after expiry, revocation, consumption, or explicit/idle/daily session reset.
- Supports hosted broker mode and custom World ID verifier settings.

## Install

Install from ClawHub once your OpenClaw build includes the required host APIs:

```sh
openclaw plugins install clawhub:@guardiola31337/agentkit
```

For local development against a sibling OpenClaw checkout:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
```

`dev:link-openclaw` replaces `node_modules/openclaw` with a symlink to the OpenClaw checkout you pass, which is useful until the required SDK APIs ship.

## Configuration

Enable the plugin through OpenClaw plugin config. This example protects the `exec` tool and asks a hosted broker to create short-lived World approval requests:

```json
{
  "plugins": {
    "entries": {
      "agentkit": {
        "enabled": true,
        "config": {
          "walletAddress": "0x0000000000000000000000000000000000000000",
          "hitl": {
            "enabled": true,
            "mode": "human-approval",
            "protectedTools": ["exec"],
            "grantScope": "session",
            "grantTtlMs": 1800000,
            "humanApproval": {
              "provider": "hosted",
              "brokerUrl": "https://example.com/world-approval"
            }
          }
        }
      }
    }
  }
}
```

For custom verifier deployments, use environment indirection for the signing key:

```json
{
  "provider": "custom",
  "appId": "app_xxx",
  "rpId": "rp_xxx",
  "signingKeyEnvVar": "WORLD_ID_SIGNING_KEY",
  "environment": "production"
}
```

Do not commit World signing keys, wallet secrets, or real user identifiers.

## Commands

Show the registration plan:

```sh
openclaw agentkit register --dry-run
```

Run registration with the configured wallet:

```sh
openclaw agentkit register
```

Check local HITL status:

```sh
openclaw agentkit status
```

For delegation approvals, run the canonical `/approve ... external ...`
command OpenClaw shows for **Verify once** or **Verify and trust for session**.
AgentKit then presents a one-use loopback resource command. Run that command
with the private key for a registered AgentKit signer. When Gateway TLS is
enabled, the generated command uses HTTPS and pins the exact Gateway leaf
certificate through `--gateway-certificate-file`; keep that argument intact.
`openclaw agentkit approve` cannot submit an allow decision directly.

`openclaw agentkit approvals` and the deny-only `openclaw agentkit approve`
command use OpenClaw's configured Gateway URL and credentials by default. If
you pass `--gateway-url`, also pass the matching `--gateway-token` or
use configured credentials; prefer environment indirection over putting secrets
directly on a command line.

## Publish

Dry-run a ClawHub publish:

```sh
pnpm clawhub:dry-run
```

Publish the beta package:

```sh
pnpm clawhub:publish
```

The publish helper expects `clawhub` on `PATH`. When using a sibling ClawHub
checkout instead of a global install, point `CLAWHUB_CLI` at its CLI entrypoint,
for example:

```sh
CLAWHUB_CLI=../clawhub/packages/clawhub/bin/clawdhub.js pnpm clawhub:dry-run
```

The publish helper tags the current beta as both `beta` and `latest` so the
default ClawHub install spec resolves. Keep the README status warning above in
place until the compatible OpenClaw host APIs are available in a released
OpenClaw build and this plugin has been tested against that release.

## Development

```sh
pnpm install
pnpm build
pnpm pack:check
```

When working against an unpublished OpenClaw API branch:

```sh
pnpm dev:link-openclaw ../openclaw
pnpm build
```

From this source checkout, run the complete local AgentKit proof against a
compatible OpenClaw checkout:

```sh
pnpm test:local-full-e2e -- --openclaw ../openclaw
```

This builds the OpenClaw checkout, links it into `node_modules/openclaw`, runs
the plugin's isolated HITL proof, then starts a real local OpenClaw Gateway with
the plugin installed from this checkout. The Gateway proof covers denial,
verify-once, exact-session trust, TTL expiry, tool/session isolation, failed
verification and fresh retry, concurrent approvals, late proof after denial,
run cancellation, graceful shutdown, and the signed delegation ceremony over a
self-signed TLS Gateway. If the OpenClaw checkout is already built, add
`--skip-host-build`.

Keep physical World App proof and its isolated production runbook on the
implementation discussion rather than in the package source. Never commit RP
signing keys, broker credentials, World identifiers, or captured proof data.

## License

MIT
