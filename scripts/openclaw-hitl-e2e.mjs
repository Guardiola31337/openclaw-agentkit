#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL_NAME = "exec";
const PLUGIN_ID = "agentkit";
const SESSION_KEY = "agentkit-e2e-session";
const AGENT_ID = "agentkit-e2e-agent";
const TOOL_CALL_ID = "agentkit-e2e-tool-call";
const GATEWAY_TIMEOUT_MS = 10_000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object", "expected a TCP server address");
  assert.ok(address?.port, "expected an allocated TCP port");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function ensureSymlink(target, linkPath) {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existingTarget = await realpath(
        path.resolve(path.dirname(linkPath), await readlink(linkPath)),
      );
      const resolvedTarget = await realpath(target);
      if (existingTarget === resolvedTarget) {
        return;
      }
    }
    await rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await symlink(target, linkPath, "dir");
}

async function importOpenClawGateway(openclawRoot) {
  const distDir = path.join(openclawRoot, "dist");
  const distFiles = await readdir(distDir);
  const serverImpl = distFiles
    .filter((name) => /^server\.impl.*\.js$/.test(name))
    .sort()
    .at(0);
  assert.ok(
    serverImpl,
    `could not find OpenClaw gateway server implementation in ${distDir}; build or link a compatible OpenClaw checkout first`,
  );
  const module = await import(pathToFileURL(path.join(distDir, serverImpl)).href);
  assert.equal(typeof module.startGatewayServer, "function");
  return module.startGatewayServer;
}

function createOpenClawConfig({ port, grantsFile }) {
  return {
    gateway: {
      port,
      mode: "local",
      auth: {
        mode: "none",
      },
      controlUi: {
        enabled: false,
      },
      tailscale: {
        mode: "off",
      },
    },
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            cli: {
              command: PLUGIN_ID,
            },
            hitl: {
              enabled: true,
              mode: "human-approval",
              protectedTools: [TOOL_NAME],
              severity: "warning",
              timeoutMs: 5_000,
              grantScope: "session",
              grantTtlMs: 60_000,
              grantsFile,
              humanApproval: {
                provider: "hosted",
                brokerUrl: "https://broker.example.test/world-approval",
                environment: "staging",
                actionPrefix: "openclaw-agentkit-e2e",
              },
            },
          },
        },
      },
    },
  };
}

function listApprovalCommands(approval) {
  const externalCommands = Array.isArray(approval?.request?.externalResolution?.commands)
    ? approval.request.externalResolution.commands
        .map((command) => (typeof command?.command === "string" ? command.command : null))
        .filter(Boolean)
    : [];
  const allowedDecisions = Array.isArray(approval?.request?.allowedDecisions)
    ? approval.request.allowedDecisions
    : [];
  const coreCommands = allowedDecisions.map((decision) => `/approve ${approval.id} ${decision}`);
  return [...externalCommands, ...coreCommands];
}

function assertAgentkitApprovalCommands(approval) {
  assert.equal(approval.request.actions, undefined);
  assert.deepEqual(approval.request.externalResolution, {
    label: "Verify with World",
    commands: [
      {
        decision: "allow-once",
        label: "Verify once",
        description: "Approve this blocked action only",
        command: `/agentkit approve ${approval.id} allow-once`,
      },
      {
        decision: "allow-always",
        label: "Verify and trust for session",
        description: "Trust approvals for this session",
        command: `/agentkit approve ${approval.id} allow-always`,
      },
    ],
  });
  const approvalCommands = listApprovalCommands(approval);
  assert.deepEqual(approvalCommands, [
    `/agentkit approve ${approval.id} allow-once`,
    `/agentkit approve ${approval.id} allow-always`,
    `/approve ${approval.id} deny`,
  ]);
  return approvalCommands;
}

async function waitForAgentkitApproval(listPendingApprovals) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const approvals = await listPendingApprovals();
    assert.ok(Array.isArray(approvals), "plugin.approval.list should return an array");
    const approval = approvals.find((record) => record?.request?.pluginId === PLUGIN_ID);
    if (approval) {
      return approval;
    }
    await delay(125);
  }
  throw new Error("timed out waiting for the AgentKit plugin approval request");
}

async function main() {
  const openclawRoot = await realpath(path.join(repoRoot, "node_modules", "openclaw"));
  const port = await getFreePort();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-agentkit-gateway-e2e-"));
  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const grantsFile = path.join(stateDir, "agentkit-grants.json");
  const extensionsDir = path.join(stateDir, "extensions");
  const pluginInstallDir = path.join(extensionsDir, PLUGIN_ID);

  const previousEnv = new Map(
    [
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ].map((key) => [key, process.env[key]]),
  );

  let gatewayServer;
  try {
    await mkdir(extensionsDir, { recursive: true });
    await ensureSymlink(repoRoot, pluginInstallDir);
    const openclawConfig = createOpenClawConfig({ port, grantsFile });
    await writeFile(configPath, `${JSON.stringify(openclawConfig, null, 2)}\n`);

    process.env.OPENCLAW_HOME = tempRoot;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_GATEWAY_PORT = String(port);
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    const startGatewayServer = await importOpenClawGateway(openclawRoot);
    gatewayServer = await startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      auth: { mode: "none" },
      tailscale: { mode: "off" },
    });

    const { runBeforeToolCallHook } = await import("openclaw/plugin-sdk/agent-harness-runtime");
    const { resolveVerifiedPluginApprovalOverGateway, withOperatorApprovalsGatewayClient } =
      await import("openclaw/plugin-sdk/gateway-runtime");

    const denyHookPromise = runBeforeToolCallHook({
      toolName: TOOL_NAME,
      params: { cmd: "echo agentkit" },
      toolCallId: TOOL_CALL_ID,
      ctx: {
        agentId: AGENT_ID,
        sessionKey: SESSION_KEY,
        runId: "agentkit-e2e-run",
      },
    });

    const denyApproval = await withOperatorApprovalsGatewayClient(
      {
        config: openclawConfig,
        clientDisplayName: "AgentKit e2e approval list",
      },
      async (client) =>
        await waitForAgentkitApproval(async () => await client.request("plugin.approval.list", {})),
    );
    const denyApprovalCommands = assertAgentkitApprovalCommands(denyApproval);

    await withOperatorApprovalsGatewayClient(
      {
        config: openclawConfig,
        clientDisplayName: "AgentKit e2e core denial",
      },
      async (client) =>
        await client.request("plugin.approval.resolve", {
          id: denyApproval.id,
          decision: "deny",
        }),
    );
    const deniedHookResult = await denyHookPromise;

    assert.equal(deniedHookResult?.blocked, true);
    assert.equal(deniedHookResult?.kind, "failure");
    assert.equal(deniedHookResult?.deniedReason, "plugin-approval");
    assert.deepEqual(deniedHookResult?.params, { cmd: "echo agentkit" });

    const allowHookPromise = runBeforeToolCallHook({
      toolName: TOOL_NAME,
      params: { cmd: "echo agentkit-allow" },
      toolCallId: `${TOOL_CALL_ID}-allow`,
      ctx: {
        agentId: AGENT_ID,
        sessionKey: SESSION_KEY,
        runId: "agentkit-e2e-run-allow",
      },
    });

    const allowApproval = await withOperatorApprovalsGatewayClient(
      {
        config: openclawConfig,
        clientDisplayName: "AgentKit e2e allow approval list",
      },
      async (client) =>
        await waitForAgentkitApproval(async () => await client.request("plugin.approval.list", {})),
    );
    const allowApprovalCommands = assertAgentkitApprovalCommands(allowApproval);

    await resolveVerifiedPluginApprovalOverGateway({
      config: openclawConfig,
      clientDisplayName: "AgentKit e2e verified allow",
      approvalId: allowApproval.id,
      decision: "allow-once",
      pluginId: PLUGIN_ID,
    });
    const allowedHookResult = await allowHookPromise;
    assert.deepEqual(allowedHookResult, {
      blocked: false,
      approvalResolution: "allow-once",
      params: { cmd: "echo agentkit-allow" },
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          openclawRoot,
          pluginInstallDir,
          deniedApprovalId: denyApproval.id,
          denyApprovalCommands,
          deniedHookResult,
          allowedApprovalId: allowApproval.id,
          allowApprovalCommands,
          allowedHookResult,
        },
        null,
        2,
      ),
    );
  } finally {
    if (gatewayServer) {
      await gatewayServer.close({ reason: "agentkit e2e complete" }).catch((error) => {
        console.error(`failed to close OpenClaw gateway: ${String(error)}`);
      });
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
