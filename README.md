# OpenClaw AgentKit

World AgentKit-backed human-in-the-loop approvals for OpenClaw protected tools.

This is a community ClawHub package published as `@guardiola31337/agentkit`. It was extracted from the OpenClaw AgentKit prototype in `openclaw/openclaw#78583` so the integration can live outside OpenClaw core. The required OpenClaw host APIs are now split across smaller upstream PRs.

## Status

- ClawHub package: `clawhub:@guardiola31337/agentkit`
- Current version: `2026.5.16-beta.2`
- Channel: community beta
- Upstream API tracker: `openclaw/openclaw#82336`
- Required OpenClaw API PRs: `openclaw/openclaw#82431`, `openclaw/openclaw#82434`, and `openclaw/openclaw#82471`
- Temporary CI host API branch: `Guardiola31337/openclaw@agentkit/external-plugin-host-apis`

The package depends on generic OpenClaw host APIs for external approval plugins. Until those APIs are available in an OpenClaw release, test this plugin against an OpenClaw checkout or beta build that includes the approval and chat injection APIs listed in `docs/host-api.md`.

## What It Does

- Registers the `agentkit` OpenClaw command.
- Adds a `before_tool_call` hook that can pause configured tools.
- Requests World-backed proof before protected tools continue.
- Supports session- or agent-scoped grants for repeated approvals.
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

### Example: Protect TweetClaw Actions

AgentKit can gate high-impact OpenClaw plugin tools while leaving safe
catalog tools available. For X/Twitter automation, install
[TweetClaw](https://github.com/Xquik-dev/tweetclaw) and protect the
live `tweetclaw` invoker. Keep the free `explore` catalog tool outside
the protected list so the agent can discover endpoints before a human
approves the live call.

```sh
openclaw plugins install @xquik/tweetclaw
```

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
            "protectedTools": ["tweetclaw"],
            "grantScope": "session",
            "grantTtlMs": 1800000,
            "humanApproval": {
              "provider": "hosted",
              "brokerUrl": "https://example.com/world-approval"
            }
          }
        }
      },
      "tweetclaw": {
        "enabled": true,
        "config": {
          "apiKey": "${XQUIK_API_KEY}"
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["explore", "tweetclaw"]
  }
}
```

That setup lets the agent search the TweetClaw endpoint catalog, then
pauses before any live Xquik-backed call such as search tweets, search
tweet replies, follower export, user lookup, monitor tweets, webhooks,
direct messages, post tweets, or post tweet replies. References:
[npm package](https://www.npmjs.com/package/@xquik/tweetclaw) and
[ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw).

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

## License

MIT
