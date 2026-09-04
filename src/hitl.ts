import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import {
  applyAgentkitExternalGrant,
  createAgentkitExternalGrantStoreAccessor,
} from "./external-verification-grants.js";
import { resolveAgentkitHumanApprovalRequestConfig } from "./human-approval.js";

const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

function isProtectedTool(toolName: string, protectedTools: string[]): boolean {
  if (protectedTools.length === 0) {
    return false;
  }
  return protectedTools.includes(toolName);
}

function buildApprovalDescription(params: {
  toolName: string;
  hitlMode: "delegation" | "human-approval";
}): string {
  const lines =
    params.hitlMode === "human-approval"
      ? [
          `Verify with World before \`${params.toolName}\` runs in this session.`,
          "Choose the canonical external verification route or deny the request.",
        ]
      : [
          `AgentKit delegation proof is required before \`${params.toolName}\` runs in this session.`,
          "Choose the canonical external verification route, then run the signed-resource command it presents.",
        ];
  const full = lines.join(" ");
  if (full.length <= MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH) {
    return full;
  }

  const fallback =
    params.hitlMode === "human-approval"
      ? `World proof of human is required before \`${params.toolName}\` can run in this session.`
      : `AgentKit delegation proof is required before \`${params.toolName}\` can run in this session.`;
  if (fallback.length <= MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH) {
    return fallback;
  }
  return fallback.slice(0, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH - 1).trimEnd() + "…";
}

export function createAgentkitBeforeToolCallHook(
  api: OpenClawPluginApi,
): (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | undefined> {
  const getGrantStore = createAgentkitExternalGrantStoreAccessor(api);
  return async (_event, ctx) => {
    const appConfig = api.runtime.config.current() as OpenClawConfig;
    const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
    if (!pluginConfig.hitl.enabled) {
      return undefined;
    }
    if (!isProtectedTool(ctx.toolName, pluginConfig.hitl.protectedTools)) {
      return undefined;
    }
    if (pluginConfig.hitl.mode === "human-approval") {
      try {
        resolveAgentkitHumanApprovalRequestConfig({
          pluginConfig,
          env: process.env,
        });
      } catch (error) {
        return {
          block: true,
          blockReason:
            error instanceof Error ? error.message : "World human approval is not configured.",
        };
      }
    }

    const appliedExternalGrant = applyAgentkitExternalGrant({
      store: getGrantStore(),
      toolName: ctx.toolName,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    if (appliedExternalGrant) {
      api.logger.info(
        `agentkit: allowed ${ctx.toolName} via verified session grant ${appliedExternalGrant.id}`,
      );
      return undefined;
    }
    const externalDecisions: Array<"allow-once" | "allow-always"> =
      ctx.sessionKey && ctx.sessionId ? ["allow-once", "allow-always"] : ["allow-once"];
    return {
      requireApproval: {
        externalResolution: {
          label:
            pluginConfig.hitl.mode === "human-approval"
              ? "Verify with World"
              : "Verify AgentKit delegation",
          decisions: externalDecisions,
        },
        title: `World proof required for ${ctx.toolName}`,
        description: buildApprovalDescription({
          toolName: ctx.toolName,
          hitlMode: pluginConfig.hitl.mode,
        }),
        severity: pluginConfig.hitl.severity,
        timeoutMs: pluginConfig.hitl.timeoutMs,
        allowedDecisions: ["deny"],
      },
    };
  };
}
