#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentkitCommand, __testing as commandTesting } from "../dist/src/command.js";
import { __testing as humanApprovalCoreTesting } from "../dist/src/human-approval.js";
import { createAgentkitBeforeToolCallHook } from "../dist/src/hitl.js";
import { __testing as humanApprovalTesting } from "../dist/src/human-approval-background.js";

const TOOL_NAME = "shell.exec";
const SESSION_KEY = "session-1";
const AGENT_ID = "agent-1";

function createConfig(grantsFile) {
  return {
    plugins: {
      entries: {
        agentkit: {
          enabled: true,
          config: {
            cli: {
              command: "agentkit",
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
                actionPrefix: "openclaw-agentkit-test",
              },
            },
          },
        },
      },
    },
  };
}

function createApi(appConfig) {
  return {
    logger: {
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    runtime: {
      config: {
        current: () => appConfig,
      },
    },
  };
}

function createPendingApproval(id, overrides = {}) {
  const nowMs = Date.now();
  return {
    id,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
    request: {
      pluginId: "agentkit",
      title: `World proof required for ${TOOL_NAME}`,
      description: "Verify with World before the protected tool runs.",
      severity: "warning",
      toolName: TOOL_NAME,
      toolCallId: `${id}-tool-call`,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      ...overrides,
    },
  };
}

function installMockHumanApprovalRuntime(approvals) {
  const resolved = [];
  const injected = [];
  const completionResolvers = new Map();
  const resolvedIds = new Set();
  const listPendingApprovals = async () =>
    approvals.filter((approval) => !resolvedIds.has(approval.id));

  humanApprovalTesting.setHumanApprovalRuntimeDeps({
    injectChatMessage: async (params) => {
      injected.push(params);
    },
    listPendingApprovals,
    renderQrCodeToString: async (input) => `qr:${input}`,
    resolvePendingApproval: async (params) => {
      resolved.push({
        approvalId: params.approvalId,
        decision: params.decision,
      });
      resolvedIds.add(params.approvalId);
    },
    startWorldHumanApprovalSession: async (params) => {
      const approvalId = params.approval.id;
      const action = `world-action-${approvalId}`;
      const connectorURI = `worldapp://verify/${approvalId}`;
      const requestId = `world-request-${approvalId}`;
      return {
        approvalId,
        action,
        connectorURI,
        requestId,
        waitForCompletion: async () =>
          await new Promise((resolve) => {
            completionResolvers.set(approvalId, () =>
              resolve({
                success: true,
                action,
                approvalId,
                connectorURI,
                requestId,
                verifyStatus: 200,
                verifyBody: { success: true },
                errorCode: null,
                pollStatus: "confirmed",
                nullifier: `nullifier-${approvalId}`,
              }),
            );
          }),
      };
    },
  });
  commandTesting.setAgentkitCommandRuntimeDeps({
    listPendingApprovals,
  });

  return {
    completeWorldApproval: (approvalId) => {
      const complete = completionResolvers.get(approvalId);
      assert.ok(complete, `World approval was not started for ${approvalId}`);
      complete();
    },
    injected,
    resolved,
  };
}

async function waitForBackgroundCompletion(approvalId) {
  const session = humanApprovalTesting.activeHumanApprovalSessions.get(approvalId);
  assert.ok(session, `approval session was not active for ${approvalId}`);
  await session.completionPromise;
  assert.equal(humanApprovalTesting.activeHumanApprovalSessions.has(approvalId), false);
}

async function assertHookRequiresWorldApproval(appConfig) {
  const hook = createAgentkitBeforeToolCallHook(createApi(appConfig));
  const result = await hook(
    {},
    {
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      toolName: TOOL_NAME,
    },
  );
  assert.ok(result?.requireApproval, "protected tool should require plugin approval");
  assert.equal(result.requireApproval.pluginId, "agentkit");
  assert.deepEqual(result.requireApproval.allowedDecisions, ["deny"]);
  assert.deepEqual(result.requireApproval.externalResolution, {
    label: "Verify with World",
    commandTemplate: "/agentkit approve {id} {decision}",
    decisions: ["allow-once", "allow-always"],
  });
  assert.equal(result.requireApproval.actions, undefined);
  assert.equal(result.requireApproval.keepPendingWithoutRoute, undefined);
}

async function assertWorldReplyIncludesAppDownload(appConfig) {
  const approval = createPendingApproval("approval-download");
  const runtime = installMockHumanApprovalRuntime([approval]);
  const command = createAgentkitCommand(createApi(appConfig));

  const reply = await command.handler({
    args: "approve approval-download allow-once",
    config: appConfig,
    sessionKey: SESSION_KEY,
  });
  assert.match(reply.text, /Scan with World App/);
  assert.match(reply.text, /Download World App: https:\/\/world\.org\/world-app/);
  assert.deepEqual(
    runtime.resolved,
    [],
    "starting the World flow should not resolve the approval before proof succeeds",
  );
}

async function assertWorldPollTimeoutReportsLastStatus() {
  let pollCount = 0;
  const result = await humanApprovalCoreTesting.pollWorldApprovalUntilCompletion({
    request: {
      pollOnce: async () => {
        pollCount += 1;
        return { type: pollCount === 1 ? "waiting_for_connection" : "awaiting_confirmation" };
      },
    },
    timeoutMs: 1_000,
    pollIntervalMs: 250,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "timeout_awaiting_confirmation");
  assert.equal(result.lastStatus, "awaiting_confirmation");
  assert.ok(pollCount > 1);
}

async function assertAllowOnceResolvesSelectedApproval(appConfig) {
  const approval = createPendingApproval("approval-once");
  const runtime = installMockHumanApprovalRuntime([approval]);
  const command = createAgentkitCommand(createApi(appConfig));

  const reply = await command.handler({
    args: "approve approval-once allow-once",
    config: appConfig,
    sessionKey: SESSION_KEY,
  });
  assert.match(reply.text, /Verify with World/);
  assert.match(reply.text, /Approval: approval-once/);

  runtime.completeWorldApproval("approval-once");
  await waitForBackgroundCompletion("approval-once");
  assert.deepEqual(runtime.resolved, [
    {
      approvalId: "approval-once",
      decision: "allow-once",
    },
  ]);
  assert.deepEqual(runtime.injected, []);
}

async function assertExplicitApprovalIdWorksWhenListIsHidden(appConfig) {
  const runtime = installMockHumanApprovalRuntime([]);
  const command = createAgentkitCommand(createApi(appConfig));

  const reply = await command.handler({
    args: "approve approval-hidden allow-once",
    config: appConfig,
    sessionKey: SESSION_KEY,
  });
  assert.match(reply.text, /Verify with World/);
  assert.match(reply.text, /Approval: approval-hidden/);

  runtime.completeWorldApproval("approval-hidden");
  await waitForBackgroundCompletion("approval-hidden");
  assert.deepEqual(runtime.resolved, [
    {
      approvalId: "approval-hidden",
      decision: "allow-once",
    },
  ]);
}

async function assertAllowAlwaysPersistsGrantAndResolvesMatchingApprovals(appConfig, grantsFile) {
  const first = createPendingApproval("approval-always");
  const second = createPendingApproval("approval-matching", {
    toolCallId: "approval-matching-tool-call",
  });
  const runtime = installMockHumanApprovalRuntime([first, second]);
  const command = createAgentkitCommand(createApi(appConfig));

  const reply = await command.handler({
    args: "approve approval-always allow-always",
    config: appConfig,
    sessionKey: SESSION_KEY,
  });
  assert.match(reply.text, /Verify with World/);
  assert.match(reply.text, /matching protected tools in this session/);

  runtime.completeWorldApproval("approval-always");
  await waitForBackgroundCompletion("approval-always");
  assert.deepEqual(runtime.resolved, [
    {
      approvalId: "approval-always",
      decision: "allow-always",
    },
    {
      approvalId: "approval-matching",
      decision: "allow-always",
    },
  ]);

  const grantFile = JSON.parse(await readFile(grantsFile, "utf8"));
  assert.equal(grantFile.version, 1);
  assert.equal(grantFile.grants.length, 1);
  assert.equal(grantFile.grants[0].decision, "allow-always");
  assert.equal(grantFile.grants[0].scope.sessionKey, SESSION_KEY);
  assert.equal(grantFile.grants[0].proofNullifier, "nullifier-approval-always");

  const hook = createAgentkitBeforeToolCallHook(createApi(appConfig));
  const result = await hook(
    {},
    {
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      toolName: TOOL_NAME,
    },
  );
  assert.equal(result, undefined, "matching grant should let the protected tool continue");
}

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-agentkit-hitl-"));
  const grantsFile = path.join(tmpDir, "grants.json");
  const appConfig = createConfig(grantsFile);
  try {
    await assertHookRequiresWorldApproval(appConfig);
    await assertWorldReplyIncludesAppDownload(appConfig);
    await assertAllowOnceResolvesSelectedApproval(appConfig);
    await assertExplicitApprovalIdWorksWhenListIsHidden(appConfig);
    await assertAllowAlwaysPersistsGrantAndResolvesMatchingApprovals(appConfig, grantsFile);
    await assertWorldPollTimeoutReportsLastStatus();
  } finally {
    commandTesting.resetAgentkitCommandRuntimeDeps();
    humanApprovalTesting.resetHumanApprovalRuntimeDeps();
    await rm(tmpDir, { force: true, recursive: true });
  }
  console.log("AgentKit HITL proof passed");
}

await main();
