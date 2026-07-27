import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { AGENTKIT_CLI_DESCRIPTOR, registerAgentkitCli } from "./src/cli.js";
import { createAgentkitCommand } from "./src/command.js";
import { AGENTKIT_DELEGATION_VERIFICATION_ROUTE } from "./src/delegation-verification.js";
import { createAgentkitExternalVerificationRuntime } from "./src/external-verification.js";
import {
  createAgentkitExternalGrantSessionGuard,
  createAgentkitSessionEndHook,
} from "./src/external-verification-grants.js";
import { createAgentkitBeforeToolCallHook } from "./src/hitl.js";

const agentkitPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "agentkit",
  name: "AgentKit",
  description: "World AgentKit support for human-backed delegation and World ID HITL approvals.",
  register(api) {
    if (!api.approvals?.onExternalVerification) {
      throw new Error(
        "AgentKit requires an OpenClaw host with plugin-owned external verification approvals.",
      );
    }
    const sessionGuard = createAgentkitExternalGrantSessionGuard();
    const externalVerification = createAgentkitExternalVerificationRuntime(api, { sessionGuard });
    api.registerCommand(createAgentkitCommand(api));
    api.approvals.onExternalVerification(externalVerification.handler);
    api.registerHttpRoute({
      path: AGENTKIT_DELEGATION_VERIFICATION_ROUTE,
      auth: "plugin",
      match: "prefix",
      handler: externalVerification.delegationHttpHandler,
    });
    api.on("before_tool_call", createAgentkitBeforeToolCallHook(api));
    api.on("session_end", createAgentkitSessionEndHook(api, sessionGuard));
    api.registerCli(
      ({ program, config: appConfig }) => {
        registerAgentkitCli(program, appConfig);
      },
      {
        descriptors: [AGENTKIT_CLI_DESCRIPTOR],
      },
    );
  },
});

export default agentkitPlugin;
