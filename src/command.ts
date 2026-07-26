import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatPendingAgentkitApprovalsText,
  listPendingAgentkitApprovals,
} from "./hitl-approvals.js";
import { formatAgentkitStatusText, resolveAgentkitStatus } from "./status.js";

type AgentkitCommandRuntimeDeps = {
  listPendingApprovals: typeof listPendingAgentkitApprovals;
};

const defaultAgentkitCommandRuntimeDeps: AgentkitCommandRuntimeDeps = {
  listPendingApprovals: listPendingAgentkitApprovals,
};

let agentkitCommandRuntimeDeps: AgentkitCommandRuntimeDeps = defaultAgentkitCommandRuntimeDeps;

function formatUsage(statusText: string): string {
  return [
    "Usage: /agentkit status",
    "Usage: /agentkit approvals",
    "Approval: use the canonical `/approve plugin:<id> external <decision>` prompt",
    "CLI-only: openclaw agentkit register",
    "CLI-only: openclaw agentkit verify-header",
    "CLI-only: openclaw agentkit verifier-server",
    "CLI-only: openclaw agentkit verifier-request",
    "CLI-only: openclaw agentkit request",
    "Usage: openclaw agentkit status",
    "",
    statusText,
  ].join("\n");
}

export function createAgentkitCommand(api: OpenClawPluginApi): OpenClawPluginCommandDefinition {
  return {
    name: "agentkit",
    description: "Inspect World AgentKit readiness, registration, and verifier flows.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const appConfig = ctx.config;
      const rawTokens = args.split(/\s+/).filter(Boolean);
      const normalizedTokens = rawTokens.map((token) => normalizeLowercaseStringOrEmpty(token));
      const [action = ""] = normalizedTokens;
      const status = await resolveAgentkitStatus({
        appConfig,
        env: process.env,
      });
      const statusText = formatAgentkitStatusText(status);
      if (!action || action === "help") {
        return { text: formatUsage(statusText) };
      }

      if (action === "status") {
        return { text: statusText };
      }

      if (action === "register") {
        return {
          text: [
            "AgentKit registration currently runs as a local host CLI flow.",
            "Run `openclaw agentkit register` on the host machine to start registration.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "approvals") {
        const approvals = await agentkitCommandRuntimeDeps.listPendingApprovals({});
        return {
          text: formatPendingAgentkitApprovalsText(approvals),
        };
      }

      if (action === "approve") {
        const approvals = await agentkitCommandRuntimeDeps.listPendingApprovals({});
        return {
          text: [
            "AgentKit verification starts only through OpenClaw's authenticated approval control lane.",
            "Use the `Verify once` or `Verify and trust for session` command shown on the pending approval.",
            "The legacy `/agentkit approve` route cannot start or resolve external verification.",
            "",
            formatPendingAgentkitApprovalsText(approvals),
          ].join("\n"),
        };
      }

      if (action === "verify" || action === "verify-header") {
        return {
          text: [
            "AgentKit header verification currently runs as a local host CLI flow.",
            "Run `openclaw agentkit verify-header --resource <url> --header-file <path>` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "request") {
        return {
          text: [
            "AgentKit protected-resource requests currently run as a local host CLI flow.",
            "Run `openclaw agentkit request --resource <url> [--private-key-file <path>]` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "verifier-server" || action === "verifier-request") {
        return {
          text: [
            "AgentKit verifier server and request flows currently run as local host CLI commands.",
            "Run `openclaw agentkit verifier-server` and `openclaw agentkit verifier-request --server <origin> [--private-key-file <path>]` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      return { text: formatUsage(statusText) };
    },
  };
}

export const __testing = {
  resetAgentkitCommandRuntimeDeps: () => {
    agentkitCommandRuntimeDeps = defaultAgentkitCommandRuntimeDeps;
  },
  setAgentkitCommandRuntimeDeps: (overrides: Partial<AgentkitCommandRuntimeDeps>) => {
    agentkitCommandRuntimeDeps = {
      ...defaultAgentkitCommandRuntimeDeps,
      ...overrides,
    };
  },
};
