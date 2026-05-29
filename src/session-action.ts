import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { formatHumanApprovalReply } from "./command.js";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import { resolveOpenClawGatewayUrlFromEnv } from "./gateway-url.js";
import {
  listPendingAgentkitApprovals,
  parseAgentkitPendingApproval,
  resolveRequestedAgentkitApproval,
  type AgentkitPendingApproval,
} from "./hitl-approvals.js";
import { startOrReuseAgentkitHumanApprovalSession } from "./human-approval-background.js";
import type { HumanApprovalCommandDecision } from "./human-approval-actions.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeApprovalDecision(value: unknown): HumanApprovalCommandDecision {
  return value === "allow-always" ? "allow-always" : "allow-once";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readApprovalId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.approvalId === "string" && payload.approvalId.trim()
    ? payload.approvalId.trim()
    : undefined;
}

function readPayloadApprovalSnapshot(payload: unknown): AgentkitPendingApproval | null {
  if (!isRecord(payload)) {
    return null;
  }
  return parseAgentkitPendingApproval(payload.approval);
}

function resolveSessionActionApproval(params: {
  approvalId?: string;
  approvals: AgentkitPendingApproval[];
  fallbackApproval: AgentkitPendingApproval | null;
}): AgentkitPendingApproval {
  if (!params.approvalId) {
    return resolveRequestedAgentkitApproval({
      approvals: params.approvals,
    });
  }

  const pendingMatch = params.approvals.find((approval) => approval.id === params.approvalId);
  if (pendingMatch) {
    return pendingMatch;
  }

  const fallback = params.fallbackApproval;
  if (!fallback) {
    throw new Error(`Pending AgentKit approval not found: ${params.approvalId}`);
  }
  if (fallback.id !== params.approvalId) {
    throw new Error(`Pending AgentKit approval snapshot mismatch: ${params.approvalId}`);
  }
  if (fallback.request.pluginId !== "agentkit") {
    throw new Error(`Pending AgentKit approval snapshot is not for AgentKit: ${params.approvalId}`);
  }
  if (fallback.expiresAtMs <= Date.now()) {
    throw new Error(`Pending AgentKit approval expired: ${params.approvalId}`);
  }
  return fallback;
}

export function createAgentkitApproveSessionAction(api: OpenClawPluginApi) {
  return {
    id: "approve",
    description: "Start the World approval flow for a pending AgentKit HITL request.",
    requiredScopes: ["operator.approvals" as const],
    schema: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        decision: { type: "string", enum: ["allow-once", "allow-always"] },
        approval: { type: "object" },
      },
      required: ["approvalId"],
      additionalProperties: false,
    },
    handler: async (ctx) => {
      const appConfig = api.runtime.config.current() as OpenClawConfig;
      const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
      if (pluginConfig.hitl.mode !== "human-approval") {
        return {
          ok: false as const,
          error: "AgentKit HITL approval resolution requires human-approval mode.",
          code: "AGENTKIT_HUMAN_APPROVAL_DISABLED",
        };
      }

      try {
        const gatewayUrl = resolveOpenClawGatewayUrlFromEnv(process.env);
        const approvals = await listPendingAgentkitApprovals({
          appConfig,
          gatewayUrl,
        });
        const approval = resolveSessionActionApproval({
          approvals,
          approvalId: readApprovalId(ctx.payload),
          fallbackApproval: readPayloadApprovalSnapshot(ctx.payload),
        });
        const decision = normalizeApprovalDecision(
          isRecord(ctx.payload) ? ctx.payload.decision : undefined,
        );
        const session = await startOrReuseAgentkitHumanApprovalSession({
          appConfig,
          approval,
          decision,
          env: process.env,
          gatewayUrl,
          logger: api.logger,
          pluginConfig,
        });

        return {
          ok: true as const,
          reply: formatHumanApprovalReply({
            approvalId: approval.id,
            connectorURI: session.connectorURI,
            decision: session.decision === "allow-always" ? "allow-always" : "allow-once",
            pluginConfig,
            qrText: session.qrText,
            requestId: session.requestId,
            reused: session.reused,
          }),
        };
      } catch (error) {
        return {
          ok: false as const,
          error: formatErrorMessage(error),
          code: "AGENTKIT_APPROVAL_ACTION_FAILED",
        };
      }
    },
  } satisfies Parameters<OpenClawPluginApi["registerSessionAction"]>[0];
}
