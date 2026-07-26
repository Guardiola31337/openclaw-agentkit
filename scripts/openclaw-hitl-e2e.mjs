#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ID = "agentkit";
const TOOL_NAME = "exec";
const OTHER_TOOL_NAME = "shell.exec";
const SESSION_KEY = "agentkit-e2e-session";
const SESSION_ID = "agentkit-e2e-session-lifecycle";
const AGENT_ID = "agentkit-e2e-agent";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address?.port);
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
      if (existingTarget === (await realpath(target))) {
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

async function importNamedDistFunction(openclawRoot, filePattern, functionName) {
  const distDir = path.join(openclawRoot, "dist");
  const fileName = (await readdir(distDir))
    .filter((name) => filePattern.test(name))
    .sort()
    .at(0);
  assert.ok(fileName, `could not find ${String(filePattern)} in ${distDir}`);
  const module = await import(pathToFileURL(path.join(distDir, fileName)).href);
  const value = Object.values(module).find(
    (candidate) => typeof candidate === "function" && candidate.name === functionName,
  );
  assert.equal(typeof value, "function", `${functionName} was not exported from ${fileName}`);
  return value;
}

function createOpenClawConfig(port, mode) {
  return {
    gateway: {
      port,
      mode: "local",
      auth: { mode: "none" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    plugins: {
      allow: [PLUGIN_ID],
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            hitl: {
              enabled: true,
              mode,
              protectedTools: [TOOL_NAME, OTHER_TOOL_NAME],
              severity: "warning",
              timeoutMs: 8_000,
              grantScope: "session",
              grantTtlMs: 1_000,
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

function createMockWorldRuntime() {
  const sessions = new Map();
  let starts = 0;
  return {
    sessions,
    get starts() {
      return starts;
    },
    start: async ({ approval, signal }) => {
      starts += 1;
      let resolveCompletion;
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
      });
      const record = {
        aborts: 0,
        approvalId: approval.id,
        action: `world-action-${approval.id}`,
        connectorURI: `worldapp://verify/${approval.id}`,
        requestId: `world-request-${approval.id}`,
        succeed: () =>
          resolveCompletion({
            success: true,
            action: record.action,
            approvalId: approval.id,
            connectorURI: record.connectorURI,
            requestId: record.requestId,
            verifyStatus: 200,
            verifyBody: { success: true },
            errorCode: null,
            pollStatus: "confirmed",
            nullifier: "plugin-private-proof",
          }),
        fail: () =>
          resolveCompletion({
            success: false,
            action: record.action,
            approvalId: approval.id,
            connectorURI: record.connectorURI,
            requestId: record.requestId,
            verifyStatus: 400,
            verifyBody: { success: false },
            errorCode: "invalid_proof",
            pollStatus: "failed",
            nullifier: null,
          }),
      };
      signal.addEventListener(
        "abort",
        () => {
          record.aborts += 1;
        },
        { once: true },
      );
      sessions.set(approval.id, record);
      return {
        approvalId: approval.id,
        action: record.action,
        connectorURI: record.connectorURI,
        requestId: record.requestId,
        waitForCompletion: async () => await completion,
      };
    },
  };
}

function assertExternalApproval(approval, label = "Verify with World") {
  assert.equal(approval.request.pluginId, PLUGIN_ID);
  assert.deepEqual(approval.request.allowedDecisions, ["deny"]);
  assert.deepEqual(approval.request.externalResolution, {
    label,
    decisions: ["allow-once", "allow-always"],
  });
  assert.equal(approval.request.actions, undefined);
}

async function waitFor(predicate, label, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const openclawRoot = await realpath(path.join(repoRoot, "node_modules", "openclaw"));
  const mode = process.env.AGENTKIT_E2E_MODE === "delegation" ? "delegation" : "human-approval";
  const port = await getFreePort();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-agentkit-gateway-e2e-"));
  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const extensionsDir = path.join(stateDir, "extensions");
  const pluginInstallDir = path.join(extensionsDir, PLUGIN_ID);
  const world = createMockWorldRuntime();
  const presentations = new Map();
  let gatewayServer;
  try {
    await mkdir(extensionsDir, { recursive: true });
    await ensureSymlink(repoRoot, pluginInstallDir);
    const openclawConfig = createOpenClawConfig(port, mode);
    await writeFile(configPath, `${JSON.stringify(openclawConfig, null, 2)}\n`);

    process.env.OPENCLAW_HOME = tempRoot;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_GATEWAY_PORT = String(port);
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    const externalVerificationModule = await import(
      pathToFileURL(path.join(repoRoot, "dist", "src", "external-verification.js")).href
    );
    externalVerificationModule.__testing.setExternalVerificationRuntimeDeps({
      renderQrCodeToString: async (input) => `qr:${input}`,
      startWorldHumanApprovalSession: world.start,
    });
    if (mode === "delegation") {
      const delegationVerificationModule = await import(
        pathToFileURL(path.join(repoRoot, "dist", "src", "delegation-verification.js")).href
      );
      delegationVerificationModule.__testing.setDelegationVerificationRuntimeDeps({
        verifyHeader: async () => ({ outcome: "verified" }),
      });
    }

    const startGatewayServer = await importNamedDistFunction(
      openclawRoot,
      /^server\.impl.*\.js$/,
      "startGatewayServer",
    );
    gatewayServer = await startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      auth: { mode: "none" },
      tailscale: { mode: "off" },
    });

    const { runBeforeToolCallHook } = await import("openclaw/plugin-sdk/agent-harness-runtime");
    const startExternalVerificationForReviewer = await importNamedDistFunction(
      openclawRoot,
      /^plugin-external-verification-runtime-.*\.js$/,
      "startExternalVerificationForReviewer",
    );
    const withOperatorApprovalsGatewayClient = await importNamedDistFunction(
      openclawRoot,
      /^operator-approvals-client-.*\.js$/,
      "withOperatorApprovalsGatewayClient",
    );
    const getGlobalHookRunner = await importNamedDistFunction(
      openclawRoot,
      /^hook-runner-global-.*\.js$/,
      "getGlobalHookRunner",
    );

    await withOperatorApprovalsGatewayClient(
      {
        config: openclawConfig,
        clientDisplayName: "AgentKit external verification e2e",
      },
      async (approvalClient) => {
        const gatewayCall = async (method, payload = {}) =>
          await approvalClient.request(method, payload);
        const listPending = async () => {
          const records = await gatewayCall("plugin.approval.list");
          return records.filter((record) => record.request.pluginId === PLUGIN_ID);
        };
        const waitForApproval = async ({ toolName = TOOL_NAME, excludeIds = [] } = {}) =>
          await waitFor(
            async () =>
              (await listPending()).find(
                (record) => record.request.toolName === toolName && !excludeIds.includes(record.id),
              ),
            `${toolName} approval`,
          );
        const deny = async (approvalId) =>
          await gatewayCall("plugin.approval.resolve", {
            id: approvalId,
            decision: "deny",
          });
        const startHook = ({
          runId,
          toolCallId,
          toolName = TOOL_NAME,
          sessionId = SESSION_ID,
          sessionKey = SESSION_KEY,
        }) =>
          runBeforeToolCallHook({
            toolName,
            params: { cmd: `echo ${runId}` },
            toolCallId,
            ctx: {
              agentId: AGENT_ID,
              sessionKey,
              sessionId,
              runId,
            },
          });
        const dispatch = async ({ approvalId, decision, interactionId }) =>
          await startExternalVerificationForReviewer({
            approvalId,
            decision,
            interactionId: createHash("sha256").update(interactionId).digest("hex"),
            present: async (message) => {
              const messages = presentations.get(approvalId) ?? [];
              messages.push(message);
              presentations.set(approvalId, messages);
            },
          });

        if (mode === "delegation") {
          const directAllowHook = startHook({
            runId: "run-delegation-direct-allow",
            toolCallId: "tool-delegation-direct-allow",
          });
          const directAllowApproval = await Promise.race([
            waitForApproval(),
            directAllowHook.then(
              (result) => {
                throw new Error(
                  `delegation hook settled before approval: ${JSON.stringify(result)}`,
                );
              },
              (error) => Promise.reject(error),
            ),
          ]);
          assertExternalApproval(directAllowApproval, "Verify AgentKit delegation");
          await assert.rejects(
            gatewayCall("plugin.approval.resolve", {
              id: directAllowApproval.id,
              decision: "allow-once",
            }),
            /allow-once is unavailable/u,
          );
          assert.ok(
            (await listPending()).some((record) => record.id === directAllowApproval.id),
            "a generic allow attempt must leave delegation pending",
          );

          const delegationAttempt = await dispatch({
            approvalId: directAllowApproval.id,
            decision: "allow-once",
            interactionId: "interaction-delegation",
          });
          const delegationPresentation = presentations.get(directAllowApproval.id)?.[0];
          const resourceUrl = delegationPresentation?.match(
            /--resource (http:\/\/127\.0\.0\.1:\d+\/plugins\/agentkit\/external-verification\/[A-Za-z0-9_-]+)/u,
          )?.[1];
          assert.ok(resourceUrl, "delegation presentation must include a one-use resource URL");
          const protectedRequestModule = await import(
            pathToFileURL(path.join(repoRoot, "dist", "src", "protected-request.js")).href
          );
          const protectedResult = await protectedRequestModule.requestAgentkitProtectedResource({
            resourceUrl,
          });
          assert.equal(protectedResult.challengeStatus, 401);
          assert.equal(protectedResult.finalStatus, 200);
          assert.deepEqual(await directAllowHook, {
            blocked: false,
            approvalResolution: "allow-once",
            params: { cmd: "echo run-delegation-direct-allow" },
          });
          assert.deepEqual(await listPending(), []);

          await gatewayServer.close({ reason: "agentkit delegation e2e complete" });
          gatewayServer = undefined;
          console.log(
            JSON.stringify(
              {
                ok: true,
                mode,
                openclawRoot,
                pluginInstallDir,
                proof: {
                  approvalId: directAllowApproval.id,
                  attemptId: delegationAttempt.id,
                  genericAllowRejected: true,
                  gatewayTls: false,
                  challengeStatus: protectedResult.challengeStatus,
                  finalStatus: protectedResult.finalStatus,
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        const denyHook = startHook({ runId: "run-deny", toolCallId: "tool-deny" });
        const denyApproval = await waitForApproval();
        assertExternalApproval(denyApproval);
        await deny(denyApproval.id);
        assert.equal((await denyHook).blocked, true);

        const onceHook = startHook({ runId: "run-once", toolCallId: "tool-once" });
        const onceApproval = await waitForApproval();
        const onceAttempt = await dispatch({
          approvalId: onceApproval.id,
          decision: "allow-once",
          interactionId: "interaction-once",
        });
        assert.match(presentations.get(onceApproval.id)[0], /Verify with World/);
        assert.match(presentations.get(onceApproval.id)[0], /worldapp:\/\/verify\//);
        assert.match(presentations.get(onceApproval.id)[0], /qr:worldapp:\/\/verify\//);
        const startsAfterOnce = world.starts;
        const replayedOnceAttempt = await dispatch({
          approvalId: onceApproval.id,
          decision: "allow-once",
          interactionId: "interaction-once",
        });
        assert.equal(replayedOnceAttempt.id, onceAttempt.id);
        assert.equal(world.starts, startsAfterOnce, "redelivery must not reinvoke AgentKit");
        world.sessions.get(onceAttempt.id).succeed();
        assert.deepEqual(await onceHook, {
          blocked: false,
          approvalResolution: "allow-once",
          params: { cmd: "echo run-once" },
        });

        const trustHook = startHook({ runId: "run-trust", toolCallId: "tool-trust" });
        const trustApproval = await waitForApproval();
        const trustAttempt = await dispatch({
          approvalId: trustApproval.id,
          decision: "allow-always",
          interactionId: "interaction-trust",
        });
        world.sessions.get(trustAttempt.id).succeed();
        assert.deepEqual(await trustHook, {
          blocked: false,
          approvalResolution: "allow-always",
          params: { cmd: "echo run-trust" },
        });

        const trustedResult = await startHook({
          runId: "run-trusted",
          toolCallId: "tool-trusted",
        });
        assert.deepEqual(trustedResult, {
          blocked: false,
          params: { cmd: "echo run-trusted" },
        });
        assert.deepEqual(await listPending(), []);

        const otherSessionHook = startHook({
          runId: "run-other-session",
          toolCallId: "tool-other-session",
          sessionId: "different-session-lifecycle",
        });
        const otherSessionApproval = await waitForApproval();
        await deny(otherSessionApproval.id);
        assert.equal((await otherSessionHook).blocked, true);

        const otherToolHook = startHook({
          runId: "run-other-tool",
          toolCallId: "tool-other-tool",
          toolName: OTHER_TOOL_NAME,
        });
        const otherToolApproval = await waitForApproval({ toolName: OTHER_TOOL_NAME });
        await deny(otherToolApproval.id);
        assert.equal((await otherToolHook).blocked, true);

        await delay(1_100);
        const expiredHook = startHook({ runId: "run-expired", toolCallId: "tool-expired" });
        const expiredApproval = await waitForApproval();
        await deny(expiredApproval.id);
        assert.equal((await expiredHook).blocked, true);

        const sessionBoundaryApprovals = {};
        for (const reason of ["reset", "idle", "daily"]) {
          const trustHook = startHook({
            runId: `run-${reason}-trust`,
            toolCallId: `tool-${reason}-trust`,
          });
          const trustApproval = await waitForApproval();
          const trustAttempt = await dispatch({
            approvalId: trustApproval.id,
            decision: "allow-always",
            interactionId: `interaction-${reason}-trust`,
          });
          world.sessions.get(trustAttempt.id).succeed();
          assert.equal((await trustHook).blocked, false);

          await getGlobalHookRunner().runSessionEnd(
            {
              sessionId: SESSION_ID,
              sessionKey: SESSION_KEY,
              messageCount: 1,
              reason,
              nextSessionId: `session-after-${reason}`,
            },
            {
              agentId: AGENT_ID,
              sessionKey: SESSION_KEY,
              sessionId: SESSION_ID,
            },
          );
          const oldLifecycleHook = startHook({
            runId: `run-${reason}-old-lifecycle`,
            toolCallId: `tool-${reason}-old-lifecycle`,
          });
          const oldLifecycleApproval = await waitForApproval();
          await deny(oldLifecycleApproval.id);
          assert.equal((await oldLifecycleHook).blocked, true);
          sessionBoundaryApprovals[reason] = oldLifecycleApproval.id;
        }

        const retryHook = startHook({ runId: "run-retry", toolCallId: "tool-retry" });
        const retryApproval = await waitForApproval();
        const attemptA = await dispatch({
          approvalId: retryApproval.id,
          decision: "allow-once",
          interactionId: "interaction-retry-a",
        });
        world.sessions.get(attemptA.id).fail();
        await waitFor(async () => {
          const replay = await dispatch({
            approvalId: retryApproval.id,
            decision: "allow-once",
            interactionId: "interaction-retry-a",
          });
          return replay.outcome === "failed" ? replay : null;
        }, "failed attempt audit");
        const startsBeforeRetry = world.starts;
        const attemptB = await dispatch({
          approvalId: retryApproval.id,
          decision: "allow-once",
          interactionId: "interaction-retry-b",
        });
        assert.notEqual(attemptB.id, attemptA.id);
        assert.equal(world.starts, startsBeforeRetry + 1);
        world.sessions.get(attemptB.id).succeed();
        assert.equal((await retryHook).blocked, false);

        const firstConcurrentHook = startHook({
          runId: "run-concurrent-a",
          toolCallId: "tool-concurrent-a",
        });
        const firstConcurrentApproval = await waitForApproval();
        const secondConcurrentHook = startHook({
          runId: "run-concurrent-b",
          toolCallId: "tool-concurrent-b",
        });
        const secondConcurrentApproval = await waitForApproval({
          excludeIds: [firstConcurrentApproval.id],
        });
        const firstConcurrentAttempt = await dispatch({
          approvalId: firstConcurrentApproval.id,
          decision: "allow-once",
          interactionId: "interaction-concurrent-a",
        });
        world.sessions.get(firstConcurrentAttempt.id).succeed();
        assert.equal((await firstConcurrentHook).blocked, false);
        assert.ok(
          (await listPending()).some((record) => record.id === secondConcurrentApproval.id),
          "resolving one approval must not resolve another",
        );
        await deny(secondConcurrentApproval.id);
        assert.equal((await secondConcurrentHook).blocked, true);

        const lateHook = startHook({ runId: "run-late", toolCallId: "tool-late" });
        const lateApproval = await waitForApproval();
        const lateAttempt = await dispatch({
          approvalId: lateApproval.id,
          decision: "allow-always",
          interactionId: "interaction-late",
        });
        await deny(lateApproval.id);
        assert.equal((await lateHook).blocked, true);
        assert.equal(world.sessions.get(lateAttempt.id).aborts, 1);
        world.sessions.get(lateAttempt.id).succeed();
        await delay(50);
        assert.deepEqual(await listPending(), []);

        const shutdownHook = startHook({
          runId: "run-shutdown",
          toolCallId: "tool-shutdown",
        });
        const shutdownApproval = await waitForApproval();
        const shutdownAttempt = await dispatch({
          approvalId: shutdownApproval.id,
          decision: "allow-once",
          interactionId: "interaction-shutdown",
        });
        await gatewayServer.close({ reason: "agentkit e2e graceful shutdown" });
        gatewayServer = undefined;
        assert.equal(world.sessions.get(shutdownAttempt.id).aborts, 1);
        assert.equal((await shutdownHook).blocked, true);

        console.log(
          JSON.stringify(
            {
              ok: true,
              openclawRoot,
              pluginInstallDir,
              proof: {
                deny: denyApproval.id,
                verifyOnce: onceApproval.id,
                sessionGrant: trustApproval.id,
                sessionBoundaries: sessionBoundaryApprovals,
                retryAttempts: [attemptA.id, attemptB.id],
                isolatedApprovals: [firstConcurrentApproval.id, secondConcurrentApproval.id],
                lateDenial: lateApproval.id,
                gracefulShutdown: shutdownApproval.id,
              },
            },
            null,
            2,
          ),
        );
      },
    );
  } finally {
    if (gatewayServer) {
      await gatewayServer.close({ reason: "agentkit e2e cleanup" }).catch(() => {});
    }
    // This script owns its process environment; keep test state active until
    // deferred plugin-registry cleanup has drained.
    await delay(250);
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
