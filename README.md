# OpenClaw AgentKit

World AgentKit-backed human-in-the-loop approvals for OpenClaw protected tools.

This is a community ClawHub package published as `@guardiola31337/agentkit`. It was extracted from the OpenClaw AgentKit prototype in `openclaw/openclaw#78583` so the integration can live outside OpenClaw core.

## Status

- ClawHub package: `clawhub:@guardiola31337/agentkit@beta`
- Current version: `2026.5.15-beta.3`
- Channel: community beta
- Upstream API tracker: `openclaw/openclaw#82336`

The package depends on generic OpenClaw host APIs for external approval plugins. Until those APIs are available in an OpenClaw release, test this plugin against an OpenClaw checkout or beta build that includes the approval APIs listed in `docs/host-api.md`.

## What It Does

- Registers the `agentkit` OpenClaw command.
- Adds a `before_tool_call` hook that can pause configured tools.
- Requests World-backed proof before protected tools continue.
- Supports session- or agent-scoped grants for repeated approvals.
- Supports hosted broker mode and custom World ID verifier settings.

## Install

Install from ClawHub once your OpenClaw build includes the required host APIs:

```sh
openclaw plugins install clawhub:@guardiola31337/agentkit@beta
```

For local development against a sibling OpenClaw checkout:

```sh
pnpm install
pnpm dev:link-openclaw ../openclaw
pnpm build
```

`dev:link-openclaw` replaces `node_modules/openclaw` with a symlink to the OpenClaw checkout you pass, which is useful while the required SDK APIs are still under review upstream.

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
  "rpId": "app_xxx",
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

## Publish

Dry-run a ClawHub publish:

```sh
clawhub package publish . \
  --family code-plugin \
  --owner Guardiola31337 \
  --version "$(node -p 'require(\"./package.json\").version')" \
  --source-repo Guardiola31337/openclaw-agentkit \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref main \
  --clawscan-note "World AgentKit integration: contacts World/AgentKit APIs, can open a local verifier callback, and uses OpenClaw operator approval APIs to resolve protected-tool HITL approvals after proof verification." \
  --tags beta \
  --dry-run
```

Publish the beta package:

```sh
clawhub package publish . \
  --family code-plugin \
  --owner Guardiola31337 \
  --version "$(node -p 'require(\"./package.json\").version')" \
  --source-repo Guardiola31337/openclaw-agentkit \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref main \
  --clawscan-note "World AgentKit integration: contacts World/AgentKit APIs, can open a local verifier callback, and uses OpenClaw operator approval APIs to resolve protected-tool HITL approvals after proof verification." \
  --tags beta
```

Publish with `--tags latest` only after the compatible OpenClaw host APIs are available in a released OpenClaw build and this plugin has been tested against that release.

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

## License

MIT
