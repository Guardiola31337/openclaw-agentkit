#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyAgentkitExternalGrant,
  createAgentkitExternalGrantStoreAccessor,
  createAgentkitSessionEndHook,
  resetAgentkitExternalSessionGrants,
  tombstoneAgentkitExternalGrant,
  upsertAgentkitExternalGrant,
} from "../dist/src/external-verification-grants.js";
import {
  __testing as externalVerificationTesting,
  createAgentkitExternalVerificationHandler,
  createAgentkitExternalVerificationRuntime,
} from "../dist/src/external-verification.js";
import { AGENTKIT } from "../dist/src/agentkit.runtime.js";
import { resolveAgentkitPluginConfig } from "../dist/src/config.js";
import { __testing as delegationVerificationTesting } from "../dist/src/delegation-verification.js";
import { createAgentkitBeforeToolCallHook } from "../dist/src/hitl.js";
import {
  __testing as hitlApprovalsTesting,
  listPendingAgentkitApprovals,
} from "../dist/src/hitl-approvals.js";
import {
  __testing as humanApprovalTesting,
  resolveAgentkitHumanApprovalRequestConfig,
} from "../dist/src/human-approval.js";

const TOOL_NAME = "shell.exec";
const SESSION_KEY = "session-key-1";
const SESSION_ID = "session-lifecycle-1";
const AGENT_ID = "agent-1";
const NOW_MS = 1_800_000_000_000;

{
  const controller = new AbortController();
  let observedSignal = null;
  const brokerRequest = humanApprovalTesting.requestHostedWorldApprovalSignature({
    action: "proof-action",
    actionDescription: "Proof action",
    brokerUrl: "https://broker.example.test/world-approval",
    environment: "staging",
    fetchImpl: async (_input, init) => {
      observedSignal = init?.signal ?? null;
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
    signal: controller.signal,
    ttlSeconds: 60,
  });
  controller.abort(new Error("broker request cancelled"));
  await assert.rejects(brokerRequest, /broker request cancelled/);
  assert.equal(observedSignal, controller.signal);
}

function createConfig(mode = "human-approval") {
  return {
    plugins: {
      entries: {
        agentkit: {
          enabled: true,
          config: {
            hitl: {
              enabled: true,
              mode,
              protectedTools: [TOOL_NAME],
              severity: "warning",
              timeoutMs: 60_000,
              grantScope: "session",
              grantTtlMs: 30_000,
              humanApproval: {
                provider: "hosted",
                brokerUrl: "https://broker.example.test/world-approval",
                environment: "staging",
                actionPrefix: "openclaw-agentkit-proof",
              },
            },
          },
        },
      },
    },
  };
}

function createMemoryStore() {
  const records = new Map();
  return {
    records,
    registerIfAbsent(key, value) {
      if (records.has(key)) {
        return false;
      }
      records.set(key, structuredClone(value));
      return true;
    },
    lookup(key) {
      const value = records.get(key);
      return value ? structuredClone(value) : undefined;
    },
    entries() {
      return [...records.entries()].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.issuedAtMs,
      }));
    },
    update(key, updater) {
      const current = records.get(key);
      const next = updater(current ? structuredClone(current) : undefined);
      if (next === undefined) {
        return false;
      }
      records.set(key, structuredClone(next));
      return true;
    },
  };
}

function createApi({ appConfig, completeExternalVerification, store }) {
  return {
    approvals: {
      onExternalVerification() {},
      completeExternalVerification,
      openGrantStore: () => store,
    },
    logger: {
      error() {},
      info() {},
      warn() {},
    },
    runtime: {
      config: {
        current: () => appConfig,
      },
      state: {},
    },
  };
}

function createAttempt(params = {}) {
  const controller = params.controller ?? new AbortController();
  const id = params.id ?? "attempt-1";
  const decision = params.decision ?? "allow-once";
  const presentations = [];
  return {
    controller,
    presentations,
    attempt: Object.freeze({
      id,
      createdAtMs: NOW_MS,
      context: Object.freeze({
        approvalId: params.approvalId ?? "approval-1",
        pluginId: "agentkit",
        runId: params.runId ?? "run-1",
        toolName: params.toolName ?? TOOL_NAME,
        toolCallId: params.toolCallId ?? "tool-call-1",
        agentId: params.agentId ?? AGENT_ID,
        sessionKey: params.sessionKey ?? SESSION_KEY,
        sessionId: params.sessionId ?? SESSION_ID,
        decision,
        label: params.label ?? "Verify with World",
        expiresAtMs: NOW_MS + 60_000,
      }),
      signal: controller.signal,
      present: async ({ message }) => {
        controller.signal.throwIfAborted();
        presentations.push(message);
      },
    }),
  };
}

function assertGrantStorageIsLazy() {
  let opens = 0;
  const api = createApi({
    appConfig: createConfig(),
    store: null,
    completeExternalVerification: async () => {
      throw new Error("unexpected completion");
    },
  });
  api.approvals.openGrantStore = () => {
    opens += 1;
    throw new Error("grant storage is unavailable during plugin discovery");
  };

  createAgentkitExternalGrantStoreAccessor(api);
  createAgentkitExternalVerificationRuntime(api);
  createAgentkitBeforeToolCallHook(api);
  createAgentkitSessionEndHook(api);
  assert.equal(opens, 0, "plugin discovery must not open Gateway-owned grant storage");
}

function createWorldRuntime() {
  const sessions = new Map();
  return {
    sessions,
    start: async ({ approval, signal }) => {
      let resolveCompletion;
      let rejectCompletion;
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const onAbort = () => rejectCompletion(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const session = {
        approvalId: approval.id,
        action: `world-action-${approval.id}`,
        connectorURI: `worldapp://verify/${approval.id}`,
        requestId: `world-request-${approval.id}`,
        waitForCompletion: async () => {
          try {
            return await completion;
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        },
      };
      sessions.set(approval.id, {
        session,
        succeed: () =>
          resolveCompletion({
            success: true,
            action: session.action,
            approvalId: approval.id,
            connectorURI: session.connectorURI,
            requestId: session.requestId,
            verifyStatus: 200,
            verifyBody: { success: true },
            errorCode: null,
            pollStatus: "confirmed",
            nullifier: "plugin-private-proof",
          }),
        fail: () =>
          resolveCompletion({
            success: false,
            action: session.action,
            approvalId: approval.id,
            connectorURI: session.connectorURI,
            requestId: session.requestId,
            verifyStatus: 400,
            verifyBody: { success: false },
            errorCode: "invalid_proof",
            pollStatus: "failed",
            nullifier: null,
          }),
      });
      return session;
    },
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function completionFor(attempt, decision, grantAuthorization) {
  return {
    applied: true,
    approval: {
      id: attempt.context.approvalId,
      kind: "plugin",
      status: "allowed",
      decision,
    },
    attempt: {
      id: attempt.id,
      context: attempt.context,
      createdAtMs: attempt.createdAtMs,
      endedAtMs: NOW_MS + 1_000,
      outcome: "succeeded",
    },
    ...(grantAuthorization ? { grantAuthorization } : {}),
  };
}

async function assertHookContract(appConfig, store) {
  const hook = createAgentkitBeforeToolCallHook(
    createApi({
      appConfig,
      store,
      completeExternalVerification: async () => {
        throw new Error("unexpected completion");
      },
    }),
  );
  const result = await hook(
    {},
    {
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      toolName: TOOL_NAME,
    },
  );
  assert.ok(result?.requireApproval);
  assert.equal(result.requireApproval.pluginId, undefined);
  assert.deepEqual(result.requireApproval.allowedDecisions, ["deny"]);
  assert.deepEqual(result.requireApproval.externalResolution, {
    label: "Verify with World",
    decisions: ["allow-once", "allow-always"],
  });
  assert.equal(result.requireApproval.actions, undefined);

  const sessionlessResult = await hook(
    {},
    {
      agentId: AGENT_ID,
      toolName: TOOL_NAME,
    },
  );
  assert.deepEqual(sessionlessResult.requireApproval.externalResolution, {
    label: "Verify with World",
    decisions: ["allow-once"],
  });
}

async function assertExplicitGatewayAuth() {
  let call = null;
  hitlApprovalsTesting.setApprovalGatewayCaller(async (...args) => {
    call = args;
    return [];
  });
  await assert.rejects(
    listPendingAgentkitApprovals({
      gatewayUrl: "wss://gateway.example.test",
    }),
    /requires --gateway-token/,
  );
  assert.equal(call, null);

  await listPendingAgentkitApprovals({
    gatewayUrl: "wss://gateway.example.test",
    gatewayToken: "test-token",
  });
  assert.equal(call?.[0], "plugin.approval.list");
  assert.deepEqual(call?.[1], {
    json: true,
    timeout: "10000",
    url: "wss://gateway.example.test",
    token: "test-token",
  });
  assert.deepEqual(call?.[2], {});
  assert.deepEqual(call?.[3], {
    clientName: "cli",
    mode: "cli",
    progress: false,
    scopes: ["operator.approvals"],
  });
}

async function assertLegacyAgentGrantIgnored(store) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentkit-legacy-grant-"));
  try {
    const grantsFile = path.join(tempDir, "grants.json");
    const appConfig = createConfig("delegation");
    const hitl = appConfig.plugins.entries.agentkit.config.hitl;
    hitl.grantScope = "agent";
    hitl.grantsFile = grantsFile;
    await writeFile(
      grantsFile,
      JSON.stringify({
        version: 1,
        grants: [
          {
            id: "legacy-agent-grant",
            approvalMode: "delegation",
            resourceUrl: null,
            decision: "allow-always",
            scope: {
              toolName: TOOL_NAME,
              sessionKey: null,
              agentId: AGENT_ID,
            },
            humanLookupMode: "agentbook",
            signerAddress: "0x0000000000000000000000000000000000000001",
            proofNullifier: null,
            grantedAtMs: NOW_MS - 1_000,
            expiresAtMs: null,
            consumedAtMs: null,
          },
        ],
      }),
    );
    const hook = createAgentkitBeforeToolCallHook(
      createApi({
        appConfig,
        store,
        completeExternalVerification: async () => {
          throw new Error("unexpected completion");
        },
      }),
    );

    const result = await hook(
      {},
      {
        agentId: AGENT_ID,
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        toolName: TOOL_NAME,
      },
    );
    assert.ok(result?.requireApproval, "legacy agent-scoped grants must not authorize new calls");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function createHttpResponse() {
  let body = null;
  const headers = new Map();
  return {
    response: {
      statusCode: 0,
      setHeader(name, value) {
        headers.set(name, value);
      },
      end(value) {
        body = JSON.parse(String(value));
      },
    },
    read() {
      return { body, headers };
    },
  };
}

async function assertDelegationContract(store) {
  const appConfig = createConfig("delegation");
  const completions = [];
  let delegationAttempt;
  let verificationCalls = 0;
  const api = createApi({
    appConfig,
    store,
    completeExternalVerification: async (completion) => {
      completions.push(completion);
      return completionFor(delegationAttempt.attempt, delegationAttempt.attempt.context.decision);
    },
  });
  delegationVerificationTesting.setDelegationVerificationRuntimeDeps({
    verifyHeader: async () => {
      verificationCalls += 1;
      if (verificationCalls === 1) {
        throw new Error("temporary verifier outage");
      }
      return { outcome: "verified" };
    },
  });
  const hook = createAgentkitBeforeToolCallHook(api);
  const hookResult = await hook(
    {},
    {
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      toolName: TOOL_NAME,
    },
  );
  assert.deepEqual(hookResult.requireApproval.allowedDecisions, ["deny"]);
  assert.deepEqual(hookResult.requireApproval.externalResolution, {
    label: "Verify AgentKit delegation",
    decisions: ["allow-once", "allow-always"],
  });

  delegationAttempt = createAttempt({
    id: "attempt-delegation",
    approvalId: "approval-delegation",
    decision: "allow-once",
    label: "Verify AgentKit delegation",
  });
  const runtime = createAgentkitExternalVerificationRuntime(api);
  await runtime.handler(delegationAttempt.attempt);
  assert.equal(delegationAttempt.presentations.length, 1);
  const resourceUrl = delegationAttempt.presentations[0].match(
    /--resource (http:\/\/127\.0\.0\.1:\d+\/plugins\/agentkit\/external-verification\/[A-Za-z0-9_-]+)/u,
  )?.[1];
  assert.ok(resourceUrl);

  const challengeResponse = createHttpResponse();
  assert.equal(
    await runtime.delegationHttpHandler(
      {
        method: "GET",
        url: new URL(resourceUrl).pathname,
        headers: {},
      },
      challengeResponse.response,
    ),
    true,
  );
  assert.equal(challengeResponse.response.statusCode, 401);
  assert.equal(challengeResponse.read().body.resourceUrl, resourceUrl);

  const retryableFailureResponse = createHttpResponse();
  await runtime.delegationHttpHandler(
    {
      method: "GET",
      url: new URL(resourceUrl).pathname,
      headers: { [AGENTKIT.toLowerCase()]: "signed-agentkit-header" },
    },
    retryableFailureResponse.response,
  );
  assert.equal(retryableFailureResponse.response.statusCode, 503);
  assert.deepEqual(completions, []);

  const proofResponse = createHttpResponse();
  await runtime.delegationHttpHandler(
    {
      method: "GET",
      url: new URL(resourceUrl).pathname,
      headers: { [AGENTKIT.toLowerCase()]: "signed-agentkit-header" },
    },
    proofResponse.response,
  );
  assert.equal(proofResponse.response.statusCode, 200);
  assert.deepEqual(completions, [{ attemptId: "attempt-delegation", outcome: "succeeded" }]);
  assert.equal(proofResponse.read().body.ok, true);
  assert.equal("report" in proofResponse.read().body, false);

  let observedSignal = null;
  delegationVerificationTesting.setDelegationVerificationRuntimeDeps({
    verifyHeader: async ({ signal }) => {
      observedSignal = signal;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const abortRuntime = createAgentkitExternalVerificationRuntime(api);
  delegationAttempt = createAttempt({
    id: "attempt-delegation-abort",
    approvalId: "approval-delegation-abort",
    decision: "allow-once",
    label: "Verify AgentKit delegation",
  });
  await abortRuntime.handler(delegationAttempt.attempt);
  const abortResourceUrl = delegationAttempt.presentations[0].match(
    /--resource (http:\/\/127\.0\.0\.1:\d+\/plugins\/agentkit\/external-verification\/[A-Za-z0-9_-]+)/u,
  )?.[1];
  assert.ok(abortResourceUrl);
  const abortResponse = createHttpResponse();
  const handling = abortRuntime.delegationHttpHandler(
    {
      method: "GET",
      url: new URL(abortResourceUrl).pathname,
      headers: { [AGENTKIT.toLowerCase()]: "signed-agentkit-header" },
    },
    abortResponse.response,
  );
  await waitFor(
    () => observedSignal === delegationAttempt.attempt.signal,
    "delegation verifier signal",
  );
  delegationAttempt.controller.abort(new Error("delegation-cancelled"));
  await handling;
  assert.equal(abortResponse.response.statusCode, 410);
  assert.deepEqual(completions, [{ attemptId: "attempt-delegation", outcome: "succeeded" }]);

  const tlsConfig = createConfig("delegation");
  tlsConfig.gateway = { tls: { enabled: true } };
  const tlsRuntime = createAgentkitExternalVerificationRuntime(
    createApi({
      appConfig: tlsConfig,
      store,
      completeExternalVerification: async () => {
        throw new Error("unexpected TLS completion");
      },
    }),
  );
  const tlsAttempt = createAttempt({
    id: "attempt-delegation-tls",
    approvalId: "approval-delegation-tls",
    decision: "allow-once",
    label: "Verify AgentKit delegation",
  });
  await assert.rejects(
    tlsRuntime.handler(tlsAttempt.attempt),
    /requires Gateway TLS to be disabled/,
  );
}

async function assertVerifyOnce(appConfig, store, world) {
  const completions = [];
  const api = createApi({
    appConfig,
    store,
    completeExternalVerification: async (completion) => {
      completions.push(completion);
      return completionFor(attempt.attempt, "allow-once");
    },
  });
  externalVerificationTesting.setExternalVerificationRuntimeDeps({
    openGrantStore: () => store,
    renderQrCodeToString: async (input) => `qr:${input}`,
    startWorldHumanApprovalSession: world.start,
  });
  const attempt = createAttempt({ id: "attempt-once", decision: "allow-once" });
  const handler = createAgentkitExternalVerificationHandler(api);
  await handler(attempt.attempt);
  assert.equal(attempt.presentations.length, 1);
  assert.match(attempt.presentations[0], /Verify with World/);
  assert.match(attempt.presentations[0], /worldapp:\/\/verify\/attempt-once/);
  assert.match(attempt.presentations[0], /qr:worldapp:\/\/verify\/attempt-once/);
  world.sessions.get("attempt-once").succeed();
  await waitFor(() => completions.length === 1, "allow-once completion");
  assert.deepEqual(completions, [{ attemptId: "attempt-once", outcome: "succeeded" }]);
  assert.equal(store.entries().length, 0, "allow-once must not create reusable trust");
}

async function assertVerifyAndTrust(appConfig, store, world) {
  const completions = [];
  const attempt = createAttempt({
    id: "attempt-always",
    approvalId: "approval-always",
    decision: "allow-always",
  });
  const authorization = {
    id: "grant-authorization-1",
    issuedAtMs: NOW_MS,
    approvalId: attempt.attempt.context.approvalId,
    attemptId: attempt.attempt.id,
    decision: "allow-always",
  };
  const api = createApi({
    appConfig,
    store,
    completeExternalVerification: async (completion) => {
      completions.push(completion);
      return completionFor(attempt.attempt, "allow-always", authorization);
    },
  });
  externalVerificationTesting.setExternalVerificationRuntimeDeps({
    openGrantStore: () => store,
    renderQrCodeToString: async () => null,
    startWorldHumanApprovalSession: world.start,
  });
  const handler = createAgentkitExternalVerificationHandler(api);
  await handler(attempt.attempt);
  world.sessions.get("attempt-always").succeed();
  await waitFor(() => store.entries().length === 1, "session grant");
  assert.deepEqual(completions, [{ attemptId: "attempt-always", outcome: "succeeded" }]);

  const grant = store.lookup(authorization.id);
  assert.equal(grant.status, "active");
  assert.equal(grant.issuedAtMs, NOW_MS);
  assert.equal(grant.expiresAtMs, NOW_MS + 30_000);
  assert.equal(grant.toolName, TOOL_NAME);
  assert.equal(grant.sessionKey, SESSION_KEY);
  assert.equal(grant.sessionId, SESSION_ID);
  assert.equal("proofNullifier" in grant, false);

  assert.equal(
    applyAgentkitExternalGrant({
      store,
      toolName: TOOL_NAME,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      nowMs: NOW_MS + 1,
    })?.id,
    authorization.id,
  );
  for (const mismatch of [
    { toolName: "other.tool", sessionKey: SESSION_KEY, sessionId: SESSION_ID },
    { toolName: TOOL_NAME, sessionKey: "other-key", sessionId: SESSION_ID },
    { toolName: TOOL_NAME, sessionKey: SESSION_KEY, sessionId: "other-lifecycle" },
  ]) {
    assert.equal(applyAgentkitExternalGrant({ store, ...mismatch, nowMs: NOW_MS + 1 }), null);
  }

  const replay = upsertAgentkitExternalGrant({
    attempt: attempt.attempt,
    completion: {
      ...completionFor(attempt.attempt, "allow-always", authorization),
      applied: false,
    },
    pluginConfig: appConfig.plugins.entries.agentkit.config,
    store,
    nowMs: NOW_MS + 10_000,
  });
  assert.equal(replay.issuedAtMs, NOW_MS);
  assert.equal(replay.expiresAtMs, NOW_MS + 30_000);
  assert.equal(store.entries().length, 1);

  assert.equal(
    tombstoneAgentkitExternalGrant({
      grantId: authorization.id,
      status: "revoked",
      store,
      nowMs: NOW_MS + 2_000,
    }),
    true,
  );
  assert.equal(store.lookup(authorization.id).status, "revoked");
  assert.equal(
    upsertAgentkitExternalGrant({
      attempt: attempt.attempt,
      completion: completionFor(attempt.attempt, "allow-always", authorization),
      pluginConfig: appConfig.plugins.entries.agentkit.config,
      store,
      nowMs: NOW_MS + 3_000,
    }).status,
    "revoked",
  );
}

async function assertExpiryAndResetTombstones(appConfig) {
  const store = createMemoryStore();
  const attempt = createAttempt({
    id: "attempt-expiring",
    approvalId: "approval-expiring",
    decision: "allow-always",
  });
  const authorization = {
    id: "grant-expiring",
    issuedAtMs: NOW_MS,
    approvalId: "approval-expiring",
    attemptId: "attempt-expiring",
    decision: "allow-always",
  };
  upsertAgentkitExternalGrant({
    attempt: attempt.attempt,
    completion: completionFor(attempt.attempt, "allow-always", authorization),
    pluginConfig: appConfig.plugins.entries.agentkit.config,
    store,
    nowMs: NOW_MS,
  });
  assert.equal(
    applyAgentkitExternalGrant({
      store,
      toolName: TOOL_NAME,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      nowMs: NOW_MS + 30_001,
    }),
    null,
  );
  assert.equal(store.lookup(authorization.id).status, "expired");
  assert.equal(
    upsertAgentkitExternalGrant({
      attempt: attempt.attempt,
      completion: completionFor(attempt.attempt, "allow-always", authorization),
      pluginConfig: appConfig.plugins.entries.agentkit.config,
      store,
      nowMs: NOW_MS + 31_000,
    }).status,
    "expired",
  );

  const resetStore = createMemoryStore();
  upsertAgentkitExternalGrant({
    attempt: attempt.attempt,
    completion: completionFor(attempt.attempt, "allow-always", {
      ...authorization,
      id: "grant-reset",
    }),
    pluginConfig: appConfig.plugins.entries.agentkit.config,
    store: resetStore,
    nowMs: NOW_MS,
  });
  assert.equal(
    resetAgentkitExternalSessionGrants({
      sessionId: SESSION_ID,
      store: resetStore,
      nowMs: NOW_MS + 1_000,
    }),
    1,
  );
  assert.equal(resetStore.lookup("grant-reset").status, "session-reset");

  const createLifecycleGrant = (reason) => {
    const lifecycleStore = createMemoryStore();
    const grantId = `grant-lifecycle-${reason ?? "missing"}`;
    upsertAgentkitExternalGrant({
      attempt: attempt.attempt,
      completion: completionFor(attempt.attempt, "allow-always", {
        ...authorization,
        id: grantId,
      }),
      pluginConfig: appConfig.plugins.entries.agentkit.config,
      store: lifecycleStore,
      nowMs: NOW_MS,
    });
    const sessionEnd = createAgentkitSessionEndHook(
      createApi({
        appConfig,
        store: lifecycleStore,
        completeExternalVerification: async () => {
          throw new Error("not used");
        },
      }),
    );
    sessionEnd({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      messageCount: 1,
      ...(reason ? { reason } : {}),
    });
    return lifecycleStore.lookup(grantId);
  };

  for (const reason of ["new", "reset", "idle", "daily", "deleted"]) {
    assert.equal(createLifecycleGrant(reason).status, "session-reset", reason);
  }
  for (const reason of ["compaction", "shutdown", "restart", "unknown", undefined]) {
    assert.equal(createLifecycleGrant(reason).status, "active", reason ?? "missing");
  }
}

async function assertFailureRetryAndAbort(appConfig) {
  const store = createMemoryStore();
  const world = createWorldRuntime();
  const completions = [];
  const api = createApi({
    appConfig,
    store,
    completeExternalVerification: async (completion) => {
      completions.push(completion);
      const attempt = completion.attemptId === "attempt-a" ? attemptA.attempt : attemptB.attempt;
      return {
        ...completionFor(attempt, attempt.context.decision),
        applied: false,
        approval: {
          id: attempt.context.approvalId,
          status: "pending",
          decision: null,
        },
      };
    },
  });
  externalVerificationTesting.setExternalVerificationRuntimeDeps({
    openGrantStore: () => store,
    renderQrCodeToString: async () => null,
    startWorldHumanApprovalSession: world.start,
  });
  const handler = createAgentkitExternalVerificationHandler(api);
  const attemptA = createAttempt({ id: "attempt-a", approvalId: "approval-retry" });
  await handler(attemptA.attempt);
  world.sessions.get("attempt-a").fail();
  await waitFor(() => completions.length === 1, "failed completion");
  assert.deepEqual(completions[0], { attemptId: "attempt-a", outcome: "failed" });

  const attemptB = createAttempt({ id: "attempt-b", approvalId: "approval-retry" });
  await handler(attemptB.attempt);
  assert.equal(world.sessions.get("attempt-b").session.approvalId, "attempt-b");
  assert.notEqual(
    world.sessions.get("attempt-a").session.action,
    world.sessions.get("attempt-b").session.action,
    "retry challenge must bind to the new attempt",
  );

  const abortAttempt = createAttempt({ id: "attempt-abort", approvalId: "approval-abort" });
  await handler(abortAttempt.attempt);
  abortAttempt.controller.abort(new Error("run-cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    completions.some((entry) => entry.attemptId === "attempt-abort"),
    false,
    "aborted verifier work must not complete the host attempt",
  );
  await assert.rejects(
    abortAttempt.attempt.present({ message: "stale challenge" }),
    /run-cancelled/,
  );
}

async function assertPollCancellation() {
  const controller = new AbortController();
  let polls = 0;
  const polling = humanApprovalTesting.pollWorldApprovalUntilCompletion({
    request: {
      pollOnce: async () => {
        polls += 1;
        return await new Promise(() => {});
      },
    },
    timeoutMs: 60_000,
    pollIntervalMs: 250,
    signal: controller.signal,
  });
  await waitFor(() => polls === 1, "initial World poll");
  controller.abort(new Error("approval-cancelled"));
  await assert.rejects(polling, /approval-cancelled/);
  assert.equal(polls, 1, "abort must release the polling loop");
}

async function assertWorldIdentifierValidation() {
  const createCustomConfig = ({ appId = "app_agentkit", rpId = "rp_agentkit" } = {}) =>
    resolveAgentkitPluginConfig({
      hitl: {
        humanApproval: {
          provider: "custom",
          appId,
          rpId,
          signingKey: "01",
        },
      },
    });

  assert.throws(
    () =>
      resolveAgentkitHumanApprovalRequestConfig({
        pluginConfig: createCustomConfig({ appId: "invalid-app" }),
      }),
    /app ID must start with `app_`/,
  );
  assert.throws(
    () =>
      resolveAgentkitHumanApprovalRequestConfig({
        pluginConfig: createCustomConfig({ rpId: "app_not-an-rp" }),
      }),
    /RP ID must start with `rp_`/,
  );

  await assert.rejects(
    humanApprovalTesting.requestHostedWorldApprovalSignature({
      action: "proof-action",
      actionDescription: "Proof action",
      brokerUrl: "https://broker.example.test/world-approval",
      environment: "staging",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            app_id: "app_agentkit",
            rp_id: "app_not-an-rp",
            nonce: "nonce",
            created_at: 1,
            expires_at: 2,
            sig: "signature",
          }),
          { status: 200 },
        ),
      ttlSeconds: 60,
    }),
    /invalid app or RP identifiers/,
  );
}

async function main() {
  const appConfig = createConfig();
  const store = createMemoryStore();
  const world = createWorldRuntime();
  try {
    assertGrantStorageIsLazy();
    await assertHookContract(appConfig, store);
    await assertExplicitGatewayAuth();
    await assertLegacyAgentGrantIgnored(createMemoryStore());
    await assertDelegationContract(createMemoryStore());
    await assertVerifyOnce(appConfig, store, world);
    await assertVerifyAndTrust(appConfig, store, world);
    await assertExpiryAndResetTombstones(appConfig);
    await assertFailureRetryAndAbort(appConfig);
    await assertPollCancellation();
    await assertWorldIdentifierValidation();
  } finally {
    externalVerificationTesting.resetExternalVerificationRuntimeDeps();
    delegationVerificationTesting.resetDelegationVerificationRuntimeDeps();
    hitlApprovalsTesting.resetApprovalGatewayCaller();
  }
  console.log("AgentKit external verification proof passed");
}

await main();
