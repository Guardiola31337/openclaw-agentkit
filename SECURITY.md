# Security

Report vulnerabilities privately to the repository owner.

This plugin can coordinate protected-tool approvals, World proof verification, and local callback handling. Treat the following as sensitive:

- World ID signing keys.
- Hosted broker credentials.
- Wallet private keys.
- Real user identifiers or approval transcripts.
- OpenClaw credentials under `~/.openclaw`.

Use environment variables such as `WORLD_ID_SIGNING_KEY` instead of committed config for verifier secrets.
