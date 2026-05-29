import type { PluginApprovalExternalResolutionTemplate } from "openclaw/plugin-sdk/approval-runtime";
import type { AgentkitPluginConfig } from "./config.js";

export type HumanApprovalCommandDecision = "allow-always" | "allow-once";

export function resolveHumanApprovalPersistentLabel(pluginConfig: AgentkitPluginConfig): string {
  return pluginConfig.hitl.grantScope === "agent"
    ? "Verify and trust for agent"
    : "Verify and trust for session";
}

export function buildHumanApprovalExternalResolutionTemplate(): PluginApprovalExternalResolutionTemplate {
  return {
    label: "Verify with World",
    commandTemplate: "/agentkit approve {id} {decision}",
    decisions: ["allow-once", "allow-always"],
  };
}

export function buildHumanApprovalCommandLines(params: {
  approvalId: string;
  pluginConfig: AgentkitPluginConfig;
}): string[] {
  return [
    "Reply with one of:",
    "Verify once: Approve this blocked action only",
    `/agentkit approve ${params.approvalId} allow-once`,
    `${resolveHumanApprovalPersistentLabel(params.pluginConfig)}: Trust AgentKit approvals for this session`,
    `/agentkit approve ${params.approvalId} allow-always`,
    "Deny: Reject this blocked action",
    `/approve ${params.approvalId} deny`,
  ];
}

export function resolveHumanApprovalCommandDecision(
  rawTokens: string[],
): HumanApprovalCommandDecision | null {
  const decisionToken = rawTokens
    .map((token) => token.trim().toLowerCase())
    .find((token) => token === "allow-once" || token === "allow-always");
  return decisionToken === "allow-always" || decisionToken === "allow-once" ? decisionToken : null;
}

export function resolveHumanApprovalApprovalIdToken(rawTokens: string[]): string | null {
  const approvalIdToken = rawTokens
    .map((token) => token.trim())
    .find((token) => token.length > 0 && token !== "allow-once" && token !== "allow-always");
  return approvalIdToken && approvalIdToken.length > 0 ? approvalIdToken : null;
}
