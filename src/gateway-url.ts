export function resolveOpenClawGatewayUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.OPENCLAW_GATEWAY_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const port = env.OPENCLAW_GATEWAY_PORT?.trim();
  if (!port) {
    return undefined;
  }
  return `ws://127.0.0.1:${port}/ws`;
}
