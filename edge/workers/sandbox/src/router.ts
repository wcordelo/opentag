import {
  isSafeIdentifier,
  validateTurnRequest,
  validateInterruptRequest,
  type RepoPolicy,
} from "../turn-contract.js";

export interface HarnessContainerStub {
  startAndWaitForPorts(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  setTurnApproval(body: Record<string, unknown>): Promise<void>;
  clearTurnApproval(executionId: string): Promise<boolean>;
}

export interface HarnessContainerNamespace {
  getByName(name: string): HarnessContainerStub;
}

export const MAX_TURN_BODY_BYTES = 1024 * 1024;

export function isValidSessionId(value: unknown): value is string {
  return isSafeIdentifier(value);
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

function isAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const authorization = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  return constantTimeEqual(authorization.slice(prefix.length), secret);
}

function ndjsonKind(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { kind?: unknown };
    return typeof event?.kind === "string" ? event.kind : undefined;
  } catch {
    return undefined;
  }
}

function abortError(): DOMException {
  return new DOMException("The harness request was cancelled", "AbortError");
}

/** Race a container lifecycle await against the caller disconnecting. */
async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Preserve NDJSON backpressure while revoking egress before a terminal line is
 * observable. Close, upstream error, and downstream cancellation revoke too.
 */
export async function wrapTurnResponse(
  upstream: Response,
  executionId: string,
  clearApproval: (executionId: string) => Promise<boolean>,
): Promise<Response> {
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  if (!upstream.body) {
    await clearApproval(executionId);
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending: string[] = [];
  let buffered = "";
  let sourceEnded = false;
  let terminalSeen = false;
  let clearPromise: Promise<boolean> | undefined;
  const clearOnce = (): Promise<boolean> => {
    clearPromise ??= clearApproval(executionId);
    return clearPromise;
  };
  const queueLine = async (line: string): Promise<void> => {
    if (terminalSeen) return;
    const kind = ndjsonKind(line);
    if (kind === "error" || kind === "done") await clearOnce();
    if (kind === "done") {
      terminalSeen = true;
    }
    pending.push(line);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (pending.length === 0 && !sourceEnded) {
          const next = await reader.read();
          if (next.done) {
            buffered += decoder.decode();
            if (buffered) await queueLine(buffered);
            buffered = "";
            sourceEnded = true;
            await clearOnce();
            break;
          }
          buffered += decoder.decode(next.value, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline + 1);
            buffered = buffered.slice(newline + 1);
            await queueLine(line);
            newline = buffered.indexOf("\n");
          }
          if (terminalSeen) {
            sourceEnded = true;
            await reader.cancel("terminal event reached").catch(() => undefined);
          }
        }
        const nextLine = pending.shift();
        if (nextLine !== undefined) controller.enqueue(encoder.encode(nextLine));
        else if (sourceEnded) controller.close();
      } catch (error) {
        try {
          await clearOnce();
        } finally {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      await clearOnce();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Validate the pinned /turn envelope, then proxy it to its named container. */
export async function routeHarnessRequest(
  request: Request,
  containers: HarnessContainerNamespace,
  authToken?: string,
  repoPolicy: RepoPolicy = {
    allowedHosts: new Set(["github.com"]),
    allowedOrgs: new Set(),
  },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ ok: true, worker: "opentag-harness" });
  }
  if (url.pathname !== "/turn" && url.pathname !== "/interrupt") return jsonError("not_found", 404);
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  if (!isAuthorized(request, authToken)) return jsonError("unauthorized", 401);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TURN_BODY_BYTES) {
    return jsonError("body_too_large", 413);
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_TURN_BODY_BYTES) {
        await reader.cancel();
        return jsonError("body_too_large", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (url.pathname === "/interrupt") {
    const validation = validateInterruptRequest(body);
    if (!validation.ok) return jsonError(validation.error, 400);
    const container = containers.getByName(validation.body.sessionId);
    // Compare-and-delete is transactional in HarnessContainer. Revoke before
    // the live signal so no GitHub write can race after Stop authorization.
    const approvalRevoked = await container.clearTurnApproval(validation.body.executionId);
    const upstream = await container.fetch(new Request("https://container/interrupt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer opentag-egress-injected-not-a-secret",
      },
      body: JSON.stringify(validation.body),
    }));
    const result = await upstream.json().catch(() => ({ interrupted: false })) as { interrupted?: boolean };
    return Response.json({ interrupted: result.interrupted === true, approvalRevoked });
  }
  const validation = validateTurnRequest(body, repoPolicy);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }

  const container = containers.getByName(validation.body.sessionId);
  await container.setTurnApproval(validation.body as unknown as Record<string, unknown>);
  const clearApproval = () =>
    container.clearTurnApproval(validation.body.executionId);
  let upstream: Response;
  try {
    // Approval is installed first so the container can never run with a stale
    // scope, then cancellation is observed before either lifecycle await.
    if (request.signal.aborted) throw abortError();
    await raceAbort(container.startAndWaitForPorts(), request.signal);
    const headers = new Headers(request.headers);
    // The public bearer is verified above and never crosses into the container.
    headers.set("Authorization", "Bearer opentag-egress-injected-not-a-secret");
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: bytes,
      signal: request.signal,
    });
    upstream = await raceAbort(container.fetch(forwarded), request.signal);
    if (request.signal.aborted) throw abortError();
    // Admission rejection/error has no stream consumer guarantee. Revoke now
    // so an interrupt-before-forward cannot leave the just-installed scope.
    if (!upstream.ok) await clearApproval();
  } catch (error) {
    await clearApproval();
    throw error;
  }
  return wrapTurnResponse(
    upstream,
    validation.body.executionId,
    (executionId) => container.clearTurnApproval(executionId),
  );
}
