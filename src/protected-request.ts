import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AGENTKIT } from "./agentkit.runtime.js";
import type { AgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import { buildAgentkitProtectedHeader } from "./protected-header.js";
import { resolveOptionalTextInputValue } from "./text-input.js";
import { type Hex } from "./viem.runtime.js";

type FetchImpl = typeof fetch;

const EVM_SIGNER_KEY_PATTERN = /^0x[0-9a-f]{64}$/iu;

export type AgentkitProtectedRequestResult = {
  resourceUrl: string;
  challengeResourceUrl: string;
  signerAddress: string;
  generatedPrivateKey: boolean;
  headerName: string;
  challengeStatus: number;
  finalStatus: number;
  responseBody: unknown;
};

export type PreparedAgentkitProtectedRequest = {
  resourceUrl: string;
  challengeResourceUrl: string;
  signerAddress: string;
  generatedPrivateKey: boolean;
  headerName: string;
  headerValue: string;
  challengeStatus: number;
};

type AgentkitChallengeEnvelope = {
  resourceUrl: string;
  challenge: AgentkitProtectedResourceChallenge;
  headerName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAgentkitProtectedResourceChallenge(
  value: unknown,
): value is AgentkitProtectedResourceChallenge {
  if (!isRecord(value) || !isRecord(value.info)) {
    return false;
  }
  const info = value.info;
  return (
    typeof info.domain === "string" &&
    typeof info.uri === "string" &&
    typeof info.version === "string" &&
    typeof info.nonce === "string" &&
    typeof info.issuedAt === "string" &&
    Array.isArray(value.supportedChains) &&
    isRecord(value.schema)
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    return JSON.parse(text) as unknown;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function resolveChallengeResourceUrl(params: {
  challenge: AgentkitProtectedResourceChallenge;
  fallbackResourceUrl: string;
}): string {
  const challengeResourceUrl = normalizeOptionalString(params.challenge.info.uri);
  return new URL(challengeResourceUrl ?? params.fallbackResourceUrl).toString();
}

function asAgentkitChallengeEnvelope(params: {
  value: unknown;
  fallbackResourceUrl: string;
}): AgentkitChallengeEnvelope {
  const { value } = params;
  if (!isRecord(value)) {
    throw new Error("AgentKit challenge response was not valid JSON.");
  }

  if ("resourceUrl" in value || "challenge" in value) {
    const resourceUrl = normalizeOptionalString(value.resourceUrl);
    if (!resourceUrl) {
      throw new Error("AgentKit challenge response did not include `resourceUrl`.");
    }

    if (!isAgentkitProtectedResourceChallenge(value.challenge)) {
      throw new Error("AgentKit challenge response did not include a valid `challenge`.");
    }

    const headerName = normalizeOptionalString(value.headerName) ?? AGENTKIT;
    return {
      resourceUrl: new URL(resourceUrl).toString(),
      challenge: value.challenge,
      headerName,
    };
  }

  const extensions = isRecord(value.extensions) ? value.extensions : null;
  const extension = extensions?.[AGENTKIT];
  if (!isAgentkitProtectedResourceChallenge(extension)) {
    throw new Error("AgentKit challenge response did not include a valid AgentKit extension.");
  }

  return {
    resourceUrl: resolveChallengeResourceUrl({
      challenge: extension,
      fallbackResourceUrl: params.fallbackResourceUrl,
    }),
    challenge: extension,
    headerName: AGENTKIT,
  };
}

function withAgentkitHeader(
  requestInit: RequestInit | undefined,
  headerName: string,
  headerValue: string,
): RequestInit {
  const headers = new Headers(requestInit?.headers);
  headers.set(headerName, headerValue);
  return {
    ...requestInit,
    headers,
  };
}

function responseHeadersFromRaw(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function normalizeCertificateFingerprint(value: string): string {
  return value.replaceAll(":", "").trim().toLowerCase();
}

async function createGatewayTlsFetch(params: {
  certificateFile: string;
  resourceUrl: string;
}): Promise<FetchImpl> {
  const certificate = await readFile(params.certificateFile, "utf8");
  const expectedFingerprint = normalizeCertificateFingerprint(
    new X509Certificate(certificate).fingerprint256,
  );
  const expectedResourceUrl = new URL(params.resourceUrl);
  if (
    expectedResourceUrl.protocol !== "https:" ||
    expectedResourceUrl.hostname !== "127.0.0.1" ||
    expectedResourceUrl.username ||
    expectedResourceUrl.password
  ) {
    throw new Error(
      "AgentKit Gateway certificate pinning is available only for an HTTPS loopback resource.",
    );
  }

  return (async (input, init) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (requestUrl.toString() !== expectedResourceUrl.toString()) {
      throw new Error("AgentKit Gateway challenge changed the pinned resource URL.");
    }
    if (init?.body) {
      throw new Error("AgentKit Gateway TLS requests do not support request bodies.");
    }
    const requestHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        requestUrl,
        {
          ca: certificate,
          // The resource is intentionally loopback. Pinning the exact Gateway
          // leaf certificate preserves server identity without relying on its DNS SAN.
          checkServerIdentity: (_hostname, peerCertificate) => {
            const actualFingerprint = normalizeCertificateFingerprint(
              peerCertificate.fingerprint256 ?? "",
            );
            return actualFingerprint === expectedFingerprint
              ? undefined
              : new Error("AgentKit Gateway certificate fingerprint mismatch.");
          },
          headers: Object.fromEntries(requestHeaders.entries()),
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            const body = Buffer.concat(chunks);
            resolve(
              new Response(body.length > 0 ? body : null, {
                headers: responseHeadersFromRaw(response.rawHeaders),
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
              }),
            );
          });
        },
      );
      request.once("error", reject);
      request.end();
    });
  }) as FetchImpl;
}

export async function resolveAgentkitPrivateKeyValue(params: {
  privateKey?: string;
  privateKeyFile?: string;
}): Promise<Hex | undefined> {
  const signerKeyHex = await resolveOptionalTextInputValue({
    value: params.privateKey,
    file: params.privateKeyFile,
    valueOptionLabel: "--private-key <hex>",
    fileOptionLabel: "--private-key-file <path>",
    valueLabel: "AgentKit private key",
  });
  if (!signerKeyHex) {
    return undefined;
  }
  if (!EVM_SIGNER_KEY_PATTERN.test(signerKeyHex)) {
    throw new Error("AgentKit private key must be a 32-byte hex string with a `0x` prefix.");
  }
  return signerKeyHex as Hex;
}

export async function requestAgentkitProtectedResource(params: {
  resourceUrl: string;
  signerKeyHex?: Hex;
  fetchImpl?: FetchImpl;
  gatewayCertificateFile?: string;
  requestInitFactory?: () => RequestInit;
}): Promise<AgentkitProtectedRequestResult> {
  const resourceUrl = new URL(params.resourceUrl).toString();
  const fetchImpl =
    params.fetchImpl ??
    (params.gatewayCertificateFile
      ? await createGatewayTlsFetch({
          certificateFile: params.gatewayCertificateFile,
          resourceUrl,
        })
      : fetch);
  const requestInitFactory = params.requestInitFactory ?? (() => ({}));

  const prepared = await prepareAgentkitProtectedRequest({
    resourceUrl,
    signerKeyHex: params.signerKeyHex,
    fetchImpl,
    requestInitFactory,
  });

  const finalResponse = await fetchImpl(
    prepared.challengeResourceUrl,
    withAgentkitHeader(requestInitFactory(), prepared.headerName, prepared.headerValue),
  );

  return {
    resourceUrl: prepared.resourceUrl,
    challengeResourceUrl: prepared.challengeResourceUrl,
    signerAddress: prepared.signerAddress,
    generatedPrivateKey: prepared.generatedPrivateKey,
    headerName: prepared.headerName,
    challengeStatus: prepared.challengeStatus,
    finalStatus: finalResponse.status,
    responseBody: await readResponseBody(finalResponse),
  };
}

export async function prepareAgentkitProtectedRequest(params: {
  resourceUrl: string;
  signerKeyHex?: Hex;
  fetchImpl?: FetchImpl;
  requestInitFactory?: () => RequestInit;
}): Promise<PreparedAgentkitProtectedRequest> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestInitFactory = params.requestInitFactory ?? (() => ({}));
  const resourceUrl = new URL(params.resourceUrl).toString();

  const challengeResponse = await fetchImpl(resourceUrl, requestInitFactory());
  const challengeBody = await readResponseBody(challengeResponse);
  if (challengeResponse.status !== 401 && challengeResponse.status !== 402) {
    throw new Error(
      `Expected AgentKit challenge response status 401 or 402, got ${challengeResponse.status}.`,
    );
  }
  const challengeEnvelope = asAgentkitChallengeEnvelope({
    value: challengeBody,
    fallbackResourceUrl: resourceUrl,
  });

  const signed = await buildAgentkitProtectedHeader({
    challenge: challengeEnvelope.challenge,
    signerKeyHex: params.signerKeyHex,
  });

  return {
    resourceUrl,
    challengeResourceUrl: challengeEnvelope.resourceUrl,
    signerAddress: signed.address,
    generatedPrivateKey: signed.generatedPrivateKey,
    headerName: challengeEnvelope.headerName,
    headerValue: signed.header,
    challengeStatus: challengeResponse.status,
  };
}

export function formatAgentkitProtectedRequestResult(
  result: AgentkitProtectedRequestResult,
): string {
  return [
    "AgentKit protected request:",
    `- requested resource: ${result.resourceUrl}`,
    `- challenge resource: ${result.challengeResourceUrl}`,
    `- header name: ${result.headerName}`,
    `- signer address: ${result.signerAddress}`,
    `- signer source: ${result.generatedPrivateKey ? "generated ephemeral key" : "user-supplied private key"}`,
    `- challenge response: ${result.challengeStatus}`,
    `- final response: ${result.finalStatus}`,
    `- verified: ${result.finalStatus === 200 ? "yes" : "no"}`,
  ].join("\n");
}
