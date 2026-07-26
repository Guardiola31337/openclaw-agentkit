import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  resolveGatewayPort,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import type { PluginExternalVerificationAttempt } from "openclaw/plugin-sdk/plugin-entry";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import { AGENTKIT } from "./agentkit.runtime.js";
import type { AgentkitPluginConfig } from "./config.js";
import {
  type AgentkitExternalGrantStore,
  upsertAgentkitExternalGrant,
} from "./external-verification-grants.js";
import { createAgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import { verifyAgentkitHeader } from "./verify.js";

export const AGENTKIT_DELEGATION_VERIFICATION_ROUTE = "/plugins/agentkit/external-verification/";

type ActiveDelegationAttempt = {
  api: OpenClawPluginApi;
  attempt: PluginExternalVerificationAttempt;
  completing: boolean;
  grantStore: AgentkitExternalGrantStore;
  onAbort: () => void;
  pluginConfig: AgentkitPluginConfig;
  resourceUrl: string;
  token: string;
};

type DelegationVerificationRuntimeDeps = {
  verifyHeader: typeof verifyAgentkitHeader;
};

const defaultDelegationVerificationRuntimeDeps: DelegationVerificationRuntimeDeps = {
  verifyHeader: verifyAgentkitHeader,
};

let delegationVerificationRuntimeDeps = defaultDelegationVerificationRuntimeDeps;
const activeDelegationAttempts = new Map<string, ActiveDelegationAttempt>();

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(`${JSON.stringify(body)}\n`);
}

function readAgentkitHeader(req: IncomingMessage): string | null {
  const raw = req.headers[AGENTKIT] ?? req.headers[AGENTKIT.toLowerCase()];
  const header = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : null;
  return header?.trim() || null;
}

function readAttemptToken(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (!pathname.startsWith(AGENTKIT_DELEGATION_VERIFICATION_ROUTE)) {
    return null;
  }
  const token = pathname.slice(AGENTKIT_DELEGATION_VERIFICATION_ROUTE.length);
  return /^[A-Za-z0-9_-]{32}$/u.test(token) ? token : null;
}

function formatDelegationChallenge(params: {
  attempt: PluginExternalVerificationAttempt;
  gatewayCertificateFile?: string;
  resourceUrl: string;
}): string {
  const gatewayCertificateArgument = params.gatewayCertificateFile
    ? ` --gateway-certificate-file ${formatShellArgument(params.gatewayCertificateFile)}`
    : "";
  return [
    "Verify AgentKit delegation",
    `Approval: ${params.attempt.context.approvalId}`,
    `Scope: ${
      params.attempt.context.decision === "allow-always"
        ? "this protected tool in this session"
        : "this blocked action only"
    }.`,
    "",
    "Run this on the OpenClaw host with a registered AgentKit signer:",
    `\`openclaw agentkit request --resource ${params.resourceUrl}${gatewayCertificateArgument} --private-key-file <path>\``,
  ].join("\n");
}

function formatShellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolveGatewayTlsCertificateFile(params: {
  api: OpenClawPluginApi;
  appConfig: OpenClawConfig;
}): string | undefined {
  const tls = params.appConfig.gateway?.tls;
  if (tls?.enabled !== true) {
    return undefined;
  }
  const configuredPath = tls.certPath;
  if (configuredPath) {
    return resolveUserPath(configuredPath);
  }
  const stateDir = params.api.runtime.state.resolveStateDir(process.env);
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const configDir =
    process.env.OPENCLAW_STATE_DIR?.trim() || !configPath
      ? stateDir
      : path.dirname(resolveUserPath(configPath));
  return path.join(configDir, "gateway", "tls", "gateway-cert.pem");
}

export function createAgentkitDelegationVerificationRuntime(params: { api: OpenClawPluginApi }) {
  const deps = delegationVerificationRuntimeDeps;

  const finish = (entry: ActiveDelegationAttempt): void => {
    if (activeDelegationAttempts.get(entry.token) === entry) {
      activeDelegationAttempts.delete(entry.token);
    }
    entry.attempt.signal.removeEventListener("abort", entry.onAbort);
  };

  const start = async (startParams: {
    attempt: PluginExternalVerificationAttempt;
    grantStore: AgentkitExternalGrantStore;
    pluginConfig: AgentkitPluginConfig;
  }): Promise<void> => {
    startParams.attempt.signal.throwIfAborted();
    const token = randomBytes(24).toString("base64url");
    const appConfig = params.api.runtime.config.current() as OpenClawConfig;
    const port = resolveGatewayPort(appConfig, process.env);
    const gatewayCertificateFile = resolveGatewayTlsCertificateFile({
      api: params.api,
      appConfig,
    });
    const resourceUrl = new URL(
      `${AGENTKIT_DELEGATION_VERIFICATION_ROUTE}${token}`,
      `${gatewayCertificateFile ? "https" : "http"}://127.0.0.1:${port}`,
    ).toString();
    let entry: ActiveDelegationAttempt;
    const onAbort = () => finish(entry);
    entry = {
      api: params.api,
      attempt: startParams.attempt,
      completing: false,
      grantStore: startParams.grantStore,
      onAbort,
      pluginConfig: startParams.pluginConfig,
      resourceUrl,
      token,
    };
    activeDelegationAttempts.set(token, entry);
    startParams.attempt.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await startParams.attempt.present({
        message: formatDelegationChallenge({
          attempt: startParams.attempt,
          gatewayCertificateFile,
          resourceUrl,
        }),
      });
    } catch (error) {
      finish(entry);
      throw error;
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const token = readAttemptToken(req);
    if (!token) {
      return false;
    }
    const entry = activeDelegationAttempts.get(token);
    if (!entry) {
      writeJson(res, 404, { ok: false, error: "verification attempt not found" });
      return true;
    }
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    if (entry.attempt.signal.aborted || entry.attempt.context.expiresAtMs <= Date.now()) {
      finish(entry);
      writeJson(res, 410, { ok: false, error: "verification attempt expired" });
      return true;
    }

    const header = readAgentkitHeader(req);
    if (!header) {
      const expirationSeconds = Math.max(
        1,
        Math.min(300, Math.ceil((entry.attempt.context.expiresAtMs - Date.now()) / 1_000)),
      );
      writeJson(res, 401, {
        ok: false,
        error: `Missing ${AGENTKIT} header.`,
        headerName: AGENTKIT,
        resourceUrl: entry.resourceUrl,
        challenge: createAgentkitProtectedResourceChallenge({
          resourceUrl: entry.resourceUrl,
          expirationSeconds,
          statement: `Authorize ${entry.attempt.context.toolName} through OpenClaw AgentKit.`,
        }),
      });
      return true;
    }
    if (entry.completing) {
      writeJson(res, 409, { ok: false, error: "verification completion already in progress" });
      return true;
    }
    entry.completing = true;

    try {
      const report = await deps.verifyHeader({
        header,
        resourceUrl: entry.resourceUrl,
        signal: entry.attempt.signal,
      });
      if (entry.attempt.signal.aborted) {
        finish(entry);
        writeJson(res, 410, { ok: false, error: "verification attempt cancelled" });
        return true;
      }
      if (report.outcome !== "verified") {
        await entry.api.approvals.completeExternalVerification({
          attemptId: entry.attempt.id,
          outcome: "failed",
        });
        finish(entry);
        writeJson(res, 403, {
          ok: false,
          error: "AgentKit delegation verification failed",
          outcome: report.outcome,
        });
        return true;
      }

      const completion = await entry.api.approvals.completeExternalVerification({
        attemptId: entry.attempt.id,
        outcome: "succeeded",
      });
      const grant = upsertAgentkitExternalGrant({
        attempt: entry.attempt,
        completion,
        pluginConfig: entry.pluginConfig,
        store: entry.grantStore,
      });
      finish(entry);
      writeJson(res, completion.applied ? 200 : 409, {
        ok: completion.applied,
        approvalId: entry.attempt.context.approvalId,
        attemptId: entry.attempt.id,
        decision: entry.attempt.context.decision,
        grantStored: grant?.status === "active",
      });
      return true;
    } catch (error) {
      finish(entry);
      if (entry.attempt.signal.aborted) {
        writeJson(res, 410, { ok: false, error: "verification attempt cancelled" });
        return true;
      }
      entry.api.logger.error(
        `agentkit: delegation verification failed for ${entry.attempt.context.approvalId}: ${String(error)}`,
      );
      writeJson(res, 409, { ok: false, error: "verification completion failed" });
      return true;
    }
  };

  return { handler, start };
}

export const __testing = {
  resetDelegationVerificationRuntimeDeps: () => {
    delegationVerificationRuntimeDeps = defaultDelegationVerificationRuntimeDeps;
  },
  setDelegationVerificationRuntimeDeps: (overrides: Partial<DelegationVerificationRuntimeDeps>) => {
    delegationVerificationRuntimeDeps = {
      ...defaultDelegationVerificationRuntimeDeps,
      ...overrides,
    };
  },
};
