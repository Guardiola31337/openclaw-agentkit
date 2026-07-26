import type {
  OpenClawPluginApi,
  PluginExternalVerificationAttempt,
  PluginExternalVerificationCompletionResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { AgentkitPluginConfig } from "./config.js";

export type AgentkitExternalGrantStatus =
  | "active"
  | "consumed"
  | "expired"
  | "revoked"
  | "session-reset";

export type AgentkitExternalGrantRecord = {
  id: string;
  status: AgentkitExternalGrantStatus;
  decision: "allow-always";
  approvalId: string;
  attemptId: string;
  toolName: string;
  sessionKey: string;
  sessionId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  endedAtMs: number | null;
};

type AgentkitExternalGrantStoreEntry = {
  key: string;
  value: AgentkitExternalGrantRecord;
};

export type AgentkitExternalGrantStore = {
  registerIfAbsent: (key: string, value: AgentkitExternalGrantRecord) => boolean;
  lookup: (key: string) => AgentkitExternalGrantRecord | undefined;
  entries: () => AgentkitExternalGrantStoreEntry[];
  update: (
    key: string,
    updateValue: (
      current: AgentkitExternalGrantRecord | undefined,
    ) => AgentkitExternalGrantRecord | undefined,
  ) => boolean;
};

export function openAgentkitExternalGrantStore(api: OpenClawPluginApi): AgentkitExternalGrantStore {
  return api.approvals.openGrantStore<AgentkitExternalGrantRecord>();
}

export function createAgentkitExternalGrantStoreAccessor(
  api: OpenClawPluginApi,
  openStore: (api: OpenClawPluginApi) => AgentkitExternalGrantStore = openAgentkitExternalGrantStore,
): () => AgentkitExternalGrantStore {
  let store: AgentkitExternalGrantStore | null = null;
  return () => {
    store ??= openStore(api);
    return store;
  };
}

function tombstoneExpiredGrant(params: {
  grant: AgentkitExternalGrantRecord;
  nowMs: number;
  store: AgentkitExternalGrantStore;
}): void {
  params.store.update(params.grant.id, (current) => {
    if (!current || current.status !== "active" || current.expiresAtMs > params.nowMs) {
      return current;
    }
    return {
      ...current,
      status: "expired",
      endedAtMs: params.nowMs,
    };
  });
}

export function applyAgentkitExternalGrant(params: {
  store: AgentkitExternalGrantStore;
  toolName: string;
  sessionKey?: string;
  sessionId?: string;
  nowMs?: number;
}): AgentkitExternalGrantRecord | null {
  if (!params.sessionKey || !params.sessionId) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  for (const entry of params.store.entries()) {
    const grant = entry.value;
    if (grant.status !== "active") {
      continue;
    }
    if (grant.expiresAtMs <= nowMs) {
      tombstoneExpiredGrant({ grant, nowMs, store: params.store });
      continue;
    }
    if (
      grant.toolName === params.toolName &&
      grant.sessionKey === params.sessionKey &&
      grant.sessionId === params.sessionId
    ) {
      return grant;
    }
  }
  return null;
}

export function upsertAgentkitExternalGrant(params: {
  attempt: PluginExternalVerificationAttempt;
  completion: PluginExternalVerificationCompletionResult;
  pluginConfig: AgentkitPluginConfig;
  store: AgentkitExternalGrantStore;
  nowMs?: number;
}): AgentkitExternalGrantRecord | null {
  const authorization = params.completion.grantAuthorization;
  const context = params.attempt.context;
  if (
    !authorization ||
    authorization.decision !== "allow-always" ||
    params.completion.approval.status !== "allowed" ||
    params.completion.approval.decision !== authorization.decision ||
    authorization.approvalId !== context.approvalId ||
    authorization.attemptId !== params.attempt.id ||
    !context.sessionKey ||
    !context.sessionId ||
    !context.toolName
  ) {
    return null;
  }

  const nowMs = params.nowMs ?? Date.now();
  const expiresAtMs = authorization.issuedAtMs + params.pluginConfig.hitl.grantTtlMs;
  const record: AgentkitExternalGrantRecord = {
    id: authorization.id,
    status: expiresAtMs > nowMs ? "active" : "expired",
    decision: "allow-always",
    approvalId: authorization.approvalId,
    attemptId: authorization.attemptId,
    toolName: context.toolName,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    issuedAtMs: authorization.issuedAtMs,
    expiresAtMs,
    endedAtMs: expiresAtMs > nowMs ? null : nowMs,
  };
  if (params.store.registerIfAbsent(record.id, record)) {
    return record;
  }
  return params.store.lookup(record.id) ?? null;
}

const GRANT_STORAGE_RETRY_INITIAL_MS = 100;
const GRANT_STORAGE_RETRY_MAX_MS = 1_000;
const GRANT_STORAGE_RETRY_BUDGET_MS = 5_000;

export async function persistAgentkitExternalGrant(params: {
  attempt: PluginExternalVerificationAttempt;
  completion: PluginExternalVerificationCompletionResult;
  pluginConfig: AgentkitPluginConfig;
  store: AgentkitExternalGrantStore;
}): Promise<AgentkitExternalGrantRecord | null> {
  const authorization = params.completion.grantAuthorization;
  if (!authorization) {
    return upsertAgentkitExternalGrant(params);
  }
  const authorizationExpiresAtMs =
    authorization.issuedAtMs + params.pluginConfig.hitl.grantTtlMs;
  const retryDeadlineMs = Math.min(
    authorizationExpiresAtMs,
    Date.now() + GRANT_STORAGE_RETRY_BUDGET_MS,
  );
  let retryDelayMs = GRANT_STORAGE_RETRY_INITIAL_MS;
  for (;;) {
    try {
      return upsertAgentkitExternalGrant(params);
    } catch (error) {
      const remainingMs = retryDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
      retryDelayMs = Math.min(retryDelayMs * 2, GRANT_STORAGE_RETRY_MAX_MS);
    }
  }
}

export function tombstoneAgentkitExternalGrant(params: {
  grantId: string;
  status: Exclude<AgentkitExternalGrantStatus, "active" | "expired">;
  store: AgentkitExternalGrantStore;
  nowMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  return params.store.update(params.grantId, (current) => {
    if (!current || current.status !== "active") {
      return current;
    }
    return {
      ...current,
      status: params.status,
      endedAtMs: nowMs,
    };
  });
}

export function resetAgentkitExternalSessionGrants(params: {
  sessionId: string;
  store: AgentkitExternalGrantStore;
  nowMs?: number;
}): number {
  const nowMs = params.nowMs ?? Date.now();
  let reset = 0;
  for (const entry of params.store.entries()) {
    if (entry.value.status !== "active" || entry.value.sessionId !== params.sessionId) {
      continue;
    }
    const changed = params.store.update(entry.key, (current) => {
      if (!current || current.status !== "active" || current.sessionId !== params.sessionId) {
        return current;
      }
      return {
        ...current,
        status: "session-reset",
        endedAtMs: nowMs,
      };
    });
    if (changed) {
      reset += 1;
    }
  }
  return reset;
}

export function createAgentkitSessionEndHook(api: OpenClawPluginApi) {
  const getStore = createAgentkitExternalGrantStoreAccessor(api);
  return (event: { sessionId: string; reason?: string }): void => {
    switch (event.reason) {
      case "new":
      case "reset":
      case "idle":
      case "daily":
      case "deleted":
        break;
      default:
        return;
    }
    resetAgentkitExternalSessionGrants({
      sessionId: event.sessionId,
      store: getStore(),
    });
  };
}
