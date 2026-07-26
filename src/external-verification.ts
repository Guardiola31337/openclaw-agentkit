import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginExternalVerificationAttempt,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import { createAgentkitDelegationVerificationRuntime } from "./delegation-verification.js";
import {
  createAgentkitExternalGrantStoreAccessor,
  openAgentkitExternalGrantStore,
  persistAgentkitExternalGrant,
  type AgentkitExternalGrantStore,
} from "./external-verification-grants.js";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";
import {
  startAgentkitWorldHumanApprovalSession,
  type AgentkitHumanApprovalSession,
  type AgentkitHumanApprovalSessionResult,
} from "./human-approval.js";
import { renderQrCodeToString } from "./qr.runtime.js";

type ExternalVerificationRuntimeDeps = {
  openGrantStore: typeof openAgentkitExternalGrantStore;
  renderQrCodeToString: typeof renderQrCodeToString;
  startWorldHumanApprovalSession: typeof startAgentkitWorldHumanApprovalSession;
};

const defaultExternalVerificationRuntimeDeps: ExternalVerificationRuntimeDeps = {
  openGrantStore: openAgentkitExternalGrantStore,
  renderQrCodeToString,
  startWorldHumanApprovalSession: startAgentkitWorldHumanApprovalSession,
};

let externalVerificationRuntimeDeps = defaultExternalVerificationRuntimeDeps;

const COMPLETION_RETRY_INITIAL_MS = 100;
const COMPLETION_RETRY_MAX_MS = 2_000;

async function waitForRetry(params: {
  delayMs: number;
  expiresAtMs: number;
  signal: AbortSignal;
}): Promise<boolean> {
  if (params.signal.aborted) {
    return false;
  }
  const delayMs = Math.min(params.delayMs, params.expiresAtMs - Date.now());
  if (delayMs <= 0) {
    return false;
  }
  return await new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (retry: boolean) => {
      if (timer) {
        clearTimeout(timer);
      }
      params.signal.removeEventListener("abort", onAbort);
      resolve(retry);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      onAbort();
    }
  });
}

async function completeExternalVerificationWithRetry(params: {
  api: OpenClawPluginApi;
  attempt: PluginExternalVerificationAttempt;
  outcome: "succeeded" | "failed";
}): Promise<
  Awaited<ReturnType<OpenClawPluginApi["approvals"]["completeExternalVerification"]>> | null
> {
  let retryDelayMs = COMPLETION_RETRY_INITIAL_MS;
  for (;;) {
    try {
      return await params.api.approvals.completeExternalVerification({
        attemptId: params.attempt.id,
        outcome: params.outcome,
      });
    } catch (error) {
      if (params.attempt.signal.aborted) {
        return null;
      }
      params.api.logger.warn(
        `agentkit: could not record ${params.outcome} verification attempt ${params.attempt.id}: ${String(error)}`,
      );
      const retry = await waitForRetry({
        delayMs: retryDelayMs,
        expiresAtMs: params.attempt.context.expiresAtMs,
        signal: params.attempt.signal,
      });
      if (!retry) {
        return null;
      }
      retryDelayMs = Math.min(retryDelayMs * 2, COMPLETION_RETRY_MAX_MS);
    }
  }
}

function toPendingApproval(attempt: PluginExternalVerificationAttempt): AgentkitPendingApproval {
  return {
    id: attempt.id,
    createdAtMs: attempt.createdAtMs,
    expiresAtMs: attempt.context.expiresAtMs,
    request: {
      pluginId: attempt.context.pluginId,
      title: `World proof required for ${attempt.context.toolName}`,
      description: "Verify with World before this protected action continues.",
      severity: "warning",
      toolName: attempt.context.toolName,
      toolCallId: attempt.context.toolCallId ?? null,
      agentId: attempt.context.agentId ?? null,
      sessionKey: attempt.context.sessionKey ?? null,
    },
  };
}

function formatChallenge(params: {
  attempt: PluginExternalVerificationAttempt;
  qrText: string | null;
  session: AgentkitHumanApprovalSession;
}): string {
  const scope =
    params.attempt.context.decision === "allow-always"
      ? "this protected tool in this session"
      : "this blocked action only";
  const lines = [
    "Verify with World",
    `Approval: ${params.attempt.context.approvalId}`,
    `World request: ${params.session.requestId}`,
    `Scope: ${scope}.`,
  ];
  if (params.qrText) {
    lines.push(
      "",
      "Scan with World App",
      "Download World App: https://world.org/world-app",
      "```text",
      params.qrText,
      "```",
    );
  }
  lines.push("", `Link: ${params.session.connectorURI}`);
  return lines.join("\n");
}

async function monitorWorldVerification(params: {
  api: OpenClawPluginApi;
  attempt: PluginExternalVerificationAttempt;
  grantStore: AgentkitExternalGrantStore;
  session: AgentkitHumanApprovalSession;
}): Promise<void> {
  let result: AgentkitHumanApprovalSessionResult;
  try {
    result = await params.session.waitForCompletion();
  } catch (error) {
    if (params.attempt.signal.aborted) {
      return;
    }
    params.api.logger.error(
      `agentkit: external verification failed for ${params.attempt.context.approvalId}: ${String(error)}`,
    );
    await completeExternalVerificationWithRetry({
      api: params.api,
      attempt: params.attempt,
      outcome: "failed",
    });
    return;
  }
  if (params.attempt.signal.aborted) {
    return;
  }

  const completion = await completeExternalVerificationWithRetry({
    api: params.api,
    attempt: params.attempt,
    outcome: result.success ? "succeeded" : "failed",
  });
  if (!completion) {
    return;
  }
  if (!result.success) {
    params.api.logger.warn(
      `agentkit: World verification failed for ${params.attempt.context.approvalId} (${result.errorCode ?? result.verifyStatus ?? "unknown"})`,
    );
    return;
  }

  try {
    const appConfig = params.api.runtime.config.current() as OpenClawConfig;
    const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
    const persistence = await persistAgentkitExternalGrant({
      attempt: params.attempt,
      completion,
      pluginConfig,
      store: params.grantStore,
      onDeferredStored: (grant) => {
        params.api.logger.info(
          `agentkit: stored deferred session grant ${grant.id} for ${grant.toolName}`,
        );
      },
      onDeferredFailure: (error) => {
        params.api.logger.error(
          `agentkit: deferred grant storage failed for ${params.attempt.context.approvalId}: ${String(error)}`,
        );
      },
    });
    if (persistence.status === "stored") {
      params.api.logger.info(
        `agentkit: stored session grant ${persistence.grant.id} for ${persistence.grant.toolName}`,
      );
    } else if (persistence.status === "pending") {
      params.api.logger.warn(
        `agentkit: session grant storage queued for ${params.attempt.context.approvalId}`,
      );
    }
  } catch (error) {
    params.api.logger.error(
      `agentkit: grant storage failed for ${params.attempt.context.approvalId}: ${String(error)}`,
    );
  }
}

export function createAgentkitExternalVerificationRuntime(api: OpenClawPluginApi) {
  const deps = externalVerificationRuntimeDeps;
  const getGrantStore = createAgentkitExternalGrantStoreAccessor(api, deps.openGrantStore);
  const delegation = createAgentkitDelegationVerificationRuntime({ api });
  const handler = async (attempt: PluginExternalVerificationAttempt): Promise<void> => {
    const grantStore = getGrantStore();
    const appConfig = api.runtime.config.current() as OpenClawConfig;
    const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
    if (!pluginConfig.hitl.enabled) {
      throw new Error("AgentKit World verification is not enabled");
    }
    if (pluginConfig.hitl.mode === "delegation") {
      await delegation.start({
        attempt,
        grantStore,
        pluginConfig,
      });
      return;
    }
    const session = await deps.startWorldHumanApprovalSession({
      approval: toPendingApproval(attempt),
      pluginConfig,
      env: process.env,
      signal: attempt.signal,
      timeoutMs: Math.max(1_000, attempt.context.expiresAtMs - Date.now()),
    });
    if (attempt.signal.aborted) {
      return;
    }
    const qrText = await deps.renderQrCodeToString(session.connectorURI);
    await attempt.present({
      message: formatChallenge({ attempt, qrText, session }),
    });
    void monitorWorldVerification({
      api,
      attempt,
      grantStore,
      session,
    });
  };
  return {
    handler,
    delegationHttpHandler: delegation.handler,
  };
}

export function createAgentkitExternalVerificationHandler(api: OpenClawPluginApi) {
  return createAgentkitExternalVerificationRuntime(api).handler;
}

export const __testing = {
  resetExternalVerificationRuntimeDeps: () => {
    externalVerificationRuntimeDeps = defaultExternalVerificationRuntimeDeps;
  },
  setExternalVerificationRuntimeDeps: (overrides: Partial<ExternalVerificationRuntimeDeps>) => {
    externalVerificationRuntimeDeps = {
      ...defaultExternalVerificationRuntimeDeps,
      ...overrides,
    };
  },
};
