# Contributing

This package tracks the OpenClaw plugin SDK and ClawHub package contract.

## Local Setup

```sh
pnpm install
pnpm build
```

If the npm `openclaw` package does not yet include the required approval APIs, link a local OpenClaw checkout:

```sh
pnpm dev:link-openclaw ../openclaw
pnpm build
```

## Checks

Run these before publishing:

```sh
pnpm build
pnpm pack:check
clawhub package publish . --family code-plugin --owner Guardiola31337 --tags beta --dry-run
```

## Scope

- Keep OpenClaw host API changes in `openclaw/openclaw`.
- Keep this repo focused on the AgentKit plugin package, docs, tests, and ClawHub release metadata.
- Do not commit credentials, signing keys, real phone numbers, or real user identifiers.
