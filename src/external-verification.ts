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
  upsertAgentkitExternalGrant,
  type AgentkitExternalGrantStore,
} from "./external-verification-grants.js";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";
import {
  startAgentkitWorldHumanApprovalSession,
  type AgentkitHumanApprovalSession,
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
  try {
    const result = await params.session.waitForCompletion();
    if (params.attempt.signal.aborted) {
      return;
    }
    const completion = await params.api.approvals.completeExternalVerification({
      attemptId: params.attempt.id,
      outcome: result.success ? "succeeded" : "failed",
    });
    if (!result.success) {
      params.api.logger.warn(
        `agentkit: World verification failed for ${params.attempt.context.approvalId} (${result.errorCode ?? result.verifyStatus ?? "unknown"})`,
      );
      return;
    }
    const appConfig = params.api.runtime.config.current() as OpenClawConfig;
    const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
    const grant = upsertAgentkitExternalGrant({
      attempt: params.attempt,
      completion,
      pluginConfig,
      store: params.grantStore,
    });
    if (grant?.status === "active") {
      params.api.logger.info(`agentkit: stored session grant ${grant.id} for ${grant.toolName}`);
    }
  } catch (error) {
    if (params.attempt.signal.aborted) {
      return;
    }
    params.api.logger.error(
      `agentkit: external verification failed for ${params.attempt.context.approvalId}: ${String(error)}`,
    );
    try {
      await params.api.approvals.completeExternalVerification({
        attemptId: params.attempt.id,
        outcome: "failed",
      });
    } catch (completionError) {
      params.api.logger.warn(
        `agentkit: could not record failed verification attempt ${params.attempt.id}: ${String(completionError)}`,
      );
    }
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
