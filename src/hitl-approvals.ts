import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

type CallGatewayFromCli = typeof callGatewayFromCli;

let approvalGatewayCaller: CallGatewayFromCli = callGatewayFromCli;

export type AgentkitPendingApproval = {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  request: {
    pluginId: string | null;
    title: string;
    description: string;
    severity: "info" | "warning" | "critical" | null;
    toolName: string | null;
    toolCallId: string | null;
    agentId: string | null;
    sessionKey: string | null;
  };
};

async function callAgentkitApprovalGateway(params: {
  method: "plugin.approval.list" | "plugin.approval.resolve";
  gatewayToken?: string;
  gatewayUrl?: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  const gatewayUrl = params.gatewayUrl?.trim();
  if (gatewayUrl && !params.gatewayToken?.trim()) {
    throw new Error("An explicit AgentKit Gateway URL requires --gateway-token.");
  }
  return await approvalGatewayCaller(
    params.method,
    {
      json: true,
      timeout: "10000",
      ...(gatewayUrl ? { url: gatewayUrl } : {}),
      ...(params.gatewayToken ? { token: params.gatewayToken } : {}),
    },
    params.payload,
    {
      clientName: "cli",
      mode: "cli",
      progress: false,
      scopes: ["operator.approvals"],
    },
  );
}

export function parseAgentkitPendingApproval(value: unknown): AgentkitPendingApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.createdAtMs !== "number" ||
    typeof record.expiresAtMs !== "number" ||
    !record.request ||
    typeof record.request !== "object" ||
    Array.isArray(record.request)
  ) {
    return null;
  }
  const request = record.request as Record<string, unknown>;
  return {
    id: record.id,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    request: {
      pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
      title: typeof request.title === "string" ? request.title : "",
      description: typeof request.description === "string" ? request.description : "",
      severity:
        request.severity === "info" ||
        request.severity === "critical" ||
        request.severity === "warning"
          ? request.severity
          : null,
      toolName: typeof request.toolName === "string" ? request.toolName : null,
      toolCallId: typeof request.toolCallId === "string" ? request.toolCallId : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
  };
}

export function createAgentkitApprovalFallback(params: {
  approvalId: string;
  sessionKey?: string | null;
  toolName?: string | null;
  nowMs?: number;
}): AgentkitPendingApproval {
  const nowMs = params.nowMs ?? Date.now();
  return {
    id: params.approvalId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 10 * 60 * 1000,
    request: {
      pluginId: "agentkit",
      title: "World proof required",
      description: "Verify with World before this protected action continues.",
      severity: "warning",
      toolName: params.toolName ?? null,
      toolCallId: null,
      agentId: null,
      sessionKey: params.sessionKey ?? null,
    },
  };
}

export async function listPendingAgentkitApprovals(params: {
  gatewayToken?: string;
  gatewayUrl?: string;
}): Promise<AgentkitPendingApproval[]> {
  const raw = await callAgentkitApprovalGateway({
    method: "plugin.approval.list",
    gatewayToken: params.gatewayToken,
    gatewayUrl: params.gatewayUrl,
    payload: {},
  });
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(parseAgentkitPendingApproval)
    .filter((entry): entry is AgentkitPendingApproval => entry?.request.pluginId === "agentkit");
}

export function resolveRequestedAgentkitApproval(params: {
  approvals: AgentkitPendingApproval[];
  approvalId?: string;
}): AgentkitPendingApproval {
  if (params.approvalId) {
    const match = params.approvals.find((entry) => entry.id === params.approvalId);
    if (!match) {
      throw new Error(`Pending AgentKit approval not found: ${params.approvalId}`);
    }
    return match;
  }
  if (params.approvals.length === 1) {
    return params.approvals[0];
  }
  if (params.approvals.length === 0) {
    throw new Error("No pending AgentKit approvals were found.");
  }
  throw new Error(
    "Multiple pending AgentKit approvals were found. Re-run with --approval-id <id>.",
  );
}

function validateFallbackApproval(params: {
  approvalId: string;
  fallbackApproval: AgentkitPendingApproval | null | undefined;
}): AgentkitPendingApproval | null {
  const fallback = params.fallbackApproval;
  if (!fallback) {
    return null;
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

export function resolveAgentkitApprovalSelection(params: {
  approvalId?: string;
  approvals: AgentkitPendingApproval[];
  fallbackApproval?: AgentkitPendingApproval | null;
  sessionKey?: string | null;
  fallbackToolName?: string | null;
}): AgentkitPendingApproval {
  if (params.approvalId) {
    const pendingMatch = params.approvals.find((approval) => approval.id === params.approvalId);
    if (pendingMatch) {
      return pendingMatch;
    }
    return (
      validateFallbackApproval({
        approvalId: params.approvalId,
        fallbackApproval: params.fallbackApproval,
      }) ??
      createAgentkitApprovalFallback({
        approvalId: params.approvalId,
        sessionKey: params.sessionKey,
        toolName: params.fallbackToolName,
      })
    );
  }

  if (params.sessionKey) {
    const sessionMatches = params.approvals.filter(
      (approval) => approval.request.sessionKey === params.sessionKey,
    );
    if (sessionMatches.length === 1) {
      return sessionMatches[0];
    }
  }

  return resolveRequestedAgentkitApproval({
    approvals: params.approvals,
  });
}

export async function denyPendingAgentkitApproval(params: {
  approvalId: string;
  gatewayToken?: string;
  gatewayUrl?: string;
}): Promise<void> {
  await callAgentkitApprovalGateway({
    method: "plugin.approval.resolve",
    gatewayToken: params.gatewayToken,
    gatewayUrl: params.gatewayUrl,
    payload: {
      id: params.approvalId,
      decision: "deny",
    },
  });
}

export function formatPendingAgentkitApprovalsText(
  approvals: AgentkitPendingApproval[],
  nowMs = Date.now(),
): string {
  if (approvals.length === 0) {
    return "No pending AgentKit approvals.";
  }
  return [
    "Pending AgentKit approvals:",
    ...approvals.map((approval) => {
      const expiresInSeconds = Math.max(0, Math.round((approval.expiresAtMs - nowMs) / 1000));
      return [
        `- ${approval.id}`,
        `  tool: ${approval.request.toolName ?? "unknown"}`,
        `  title: ${approval.request.title}`,
        `  agent: ${approval.request.agentId ?? "unknown"}`,
        `  session: ${approval.request.sessionKey ?? "unknown"}`,
        `  expires in: ${expiresInSeconds}s`,
      ].join("\n");
    }),
  ].join("\n");
}

export const __testing = {
  resetApprovalGatewayCaller: () => {
    approvalGatewayCaller = callGatewayFromCli;
  },
  setApprovalGatewayCaller: (caller: CallGatewayFromCli) => {
    approvalGatewayCaller = caller;
  },
};
