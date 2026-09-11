/**
 * The only network call in this extension.
 *
 * Every guard in the project converges here. The signature takes an AgentRequest
 * — the type only `redaction/build-request.ts` produces — so there is no way to
 * reach this function with a raw snapshot, and the manifest grants host access to
 * exactly one origin. If you are adding a second fetch anywhere in this codebase,
 * stop: that is the failure CLAUDE.md describes, and it will not be caught by the
 * type system twice.
 */
import type { AgentRequest, AgentResponse } from '../shared/schema';
import { api } from '../shared/browser';

const SERVER_URL_KEY = 'athena:server-url';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

export async function getServerUrl(): Promise<string> {
  const stored = await api.storage.local.get(SERVER_URL_KEY);
  return (stored?.[SERVER_URL_KEY] as string | undefined) ?? DEFAULT_SERVER_URL;
}

export async function setServerUrl(url: string): Promise<void> {
  await api.storage.local.set({ [SERVER_URL_KEY]: url });
}

export class ServerRejectedPayloadError extends Error {
  constructor(readonly findings: string[]) {
    super(
      `The server's ingress check found raw PII the client should have redacted: ${findings.join('; ')}`,
    );
    this.name = 'ServerRejectedPayloadError';
  }
}

export async function requestPlan(request: AgentRequest): Promise<AgentResponse> {
  const response = await fetch(`${await getServerUrl()}/agent/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (response.status === 422) {
    // PRD §6.2.6 firing is a client bug, not a server error — surface it loudly
    // rather than retrying, because a retry sends the same leak again.
    const body = (await response.json()) as { error?: string; findings?: string[] };
    if (body?.error === 'raw_pii_in_payload') throw new ServerRejectedPayloadError(body.findings ?? []);
    throw new Error(`Server rejected the payload: ${JSON.stringify(body)}`);
  }
  if (!response.ok) throw new Error(`Server returned ${response.status} ${response.statusText}`);

  return (await response.json()) as AgentResponse;
}

export async function checkHealth(): Promise<{ status: string; provider: string; ingress_policy: string }> {
  const response = await fetch(`${await getServerUrl()}/healthz`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return await response.json();
}
