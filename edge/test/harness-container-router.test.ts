import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { interruptHarnessTurn, runHarnessTurn } from "../src/harness/client.js";
import { bindRequestContext, slackTurnIdentity } from "../src/request-context.js";
import {
  authorizeGithubWrite,
  buildApprovalScope,
  type GithubApprovalScope,
} from "../workers/sandbox/src/egress-policy.js";
import {
  isValidSessionId,
  MAX_TURN_BODY_BYTES,
  routeHarnessRequest,
  type HarnessContainerNamespace,
} from "../workers/sandbox/src/router.js";

const EXEC_A = `ot1e_${"A".repeat(43)}`;
const EXEC_B = `ot1e_${"B".repeat(43)}`;
const FORWARDED_A = `ot1m_${"A".repeat(43)}`;

function fakeNamespace(response = new Response("stream")) {
  const startAndWaitForPorts = vi.fn(async () => undefined);
  const setTurnApproval = vi.fn(async (_body: Record<string, unknown>) => undefined);
  const clearTurnApproval = vi.fn(async (_executionId: string) => true);
  const fetch = vi.fn(async (_request: Request) => response);
  const getByName = vi.fn((_name: string) => ({ startAndWaitForPorts, setTurnApproval, clearTurnApproval, fetch }));
  return {
    namespace: { getByName } satisfies HarnessContainerNamespace,
    getByName,
    startAndWaitForPorts,
    setTurnApproval,
    clearTurnApproval,
    fetch,
  };
}

describe("harness Container frontend", () => {
  const authToken = "shared-worker-secret";
  const validTurn = {
    sessionId: "sess-1",
    executionId: EXEC_A,
    forwardedMessageId: FORWARDED_A,
    threadKey: "slack:C1:1.2",
    inputLines: ["hello"],
  };

  it("accepts one real Slack identity unchanged through /turn and exact /interrupt", async () => {
    const identity = await slackTurnIdentity(bindRequestContext({}, {
      teamId: "T:équipe/東京",
      requesterId: "U1",
      inbound: {
        channel: "C-special_" + "界".repeat(255),
        threadTs: "1700000000.000001",
        ts: "1700000001.000002",
      },
    }), "C-special_" + "界".repeat(255));
    const approvedBodies: Record<string, unknown>[] = [];
    const containerFetch = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/interrupt"
        ? Response.json({ interrupted: true })
        : new Response('{"kind":"done","payload":{"ok":true}}\n', {
            headers: { "content-type": "application/x-ndjson" },
          }));
    const namespace: HarnessContainerNamespace = {
      getByName: () => ({
        startAndWaitForPorts: async () => undefined,
        fetch: containerFetch,
        setTurnApproval: async (body) => { approvedBodies.push(body); },
        clearTurnApproval: async () => true,
      }),
    };
    const service = {
      fetch: (url: string, init?: RequestInit) =>
        routeHarnessRequest(new Request(url, init), namespace, authToken),
    };
    const session = {
      create: async () => ({ sessionId: "sess-1", restarted: false }),
      execute: async () => ({ accepted: true, duplicate: false }),
      appendEvent: async () => ({ id: 1 }),
      replay: async () => [],
      getState: async () => ({ interrupted: false }),
    };
    const env = {
      HARNESS: service,
      HARNESS_AUTH_TOKEN: authToken,
      SESSION_EVENTS: {
        idFromName: (name: string) => name,
        get: () => session,
      },
    } as unknown as Env;
    const threadKey = "slack:C-special_:1700000000.000001";

    expect(await runHarnessTurn(env, {
      threadKey,
      conversationKey: "conversation",
      ...identity,
      prompt: "hello",
    })).toMatchObject({ ok: true });
    expect(approvedBodies[0]).toMatchObject(identity);
    expect(await interruptHarnessTurn(env, {
      sessionId: "sess-1", threadKey, executionId: identity.executionId,
    })).toEqual({ accepted: true, interrupted: true, approvalRevoked: true });
    const interruptBody = await (containerFetch.mock.calls.at(-1)![0] as Request).json();
    expect(interruptBody).toMatchObject({ executionId: identity.executionId });

    for (const legacy of ["slack:C1:111.333", identity.forwardedMessageId, "../escape"]) {
      const response = await routeHarnessRequest(new Request("https://harness/interrupt", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ sessionId: "sess-1", threadKey, executionId: legacy }),
      }), namespace, authToken);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_execution_id" });
    }
  });

  it("accepts durable session names and rejects unsafe names", () => {
    expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidSessionId("session-thread_1")).toBe(true);
    expect(isValidSessionId("session:thread_1.2")).toBe(false);
    expect(isValidSessionId("../escape")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("x".repeat(129))).toBe(false);
  });

  it("starts the named container and forwards the original streaming request", async () => {
    const fake = fakeNamespace(
      new Response('{"kind":"done"}\n', {
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const request = new Request("https://harness/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(validTurn),
    });

    const response = await routeHarnessRequest(request, fake.namespace, authToken);

    expect(fake.getByName).toHaveBeenCalledWith("sess-1");
    expect(fake.startAndWaitForPorts).toHaveBeenCalledOnce();
    expect(fake.setTurnApproval).toHaveBeenCalledWith(expect.objectContaining({ executionId: EXEC_A }));
    expect(fake.fetch).toHaveBeenCalledOnce();
    const forwarded = fake.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("authorization")).toBe("Bearer opentag-egress-injected-not-a-secret");
    expect(await forwarded.json()).toEqual(validTurn);
    expect(await response.text()).toContain('"kind":"done"');
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
  });

  it("authenticates and forwards an exact interrupt only after approval revocation", async () => {
    const order: string[] = [];
    const clearTurnApproval = vi.fn(async (executionId: string) => {
      order.push(`revoke:${executionId}`);
      return true;
    });
    const fetch = vi.fn(async (request: Request) => {
      order.push(`fetch:${new URL(request.url).pathname}`);
      return Response.json({ interrupted: true });
    });
    const getByName = vi.fn(() => ({
      startAndWaitForPorts: async () => undefined,
      setTurnApproval: async () => undefined,
      clearTurnApproval,
      fetch,
    }));
    const response = await routeHarnessRequest(new Request("https://harness/interrupt", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId: "sess-1", executionId: EXEC_A, threadKey: "slack:C1:1.2" }),
    }), { getByName }, authToken);
    expect(await response.json()).toEqual({ interrupted: true, approvalRevoked: true });
    expect(getByName).toHaveBeenCalledWith("sess-1");
    expect(order).toEqual([`revoke:${EXEC_A}`, "fetch:/interrupt"]);
  });

  it.each([
    ["upstream 500", new Response("failed", { status: 500 }), 500, "interrupt_upstream_failed"],
    ["invalid JSON", new Response("not-json", { status: 200 }), 502, "invalid_interrupt_response"],
    ["missing boolean", Response.json({ interrupted: "yes" }), 502, "invalid_interrupt_response"],
  ])("does not acknowledge an interrupt with %s", async (_label, upstream, status, error) => {
    const fake = fakeNamespace(upstream);
    const response = await routeHarnessRequest(new Request("https://harness/interrupt", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId: "sess-1", executionId: EXEC_A, threadKey: "slack:C1:1.2" }),
    }), fake.namespace, authToken);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
  });

  it("acknowledges a validated 200 false as an exact no-live-process no-op", async () => {
    const fake = fakeNamespace(Response.json({ interrupted: false }));
    const response = await routeHarnessRequest(new Request("https://harness/interrupt", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId: "sess-1", executionId: EXEC_A, threadKey: "slack:C1:1.2" }),
    }), fake.namespace, authToken);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interrupted: false, approvalRevoked: true });
  });

  it("only marks the edge interrupt accepted for a validated 2xx boolean body", async () => {
    const responses = [
      new Response("failed", { status: 500 }),
      new Response("not-json", { status: 200 }),
      Response.json({ approvalRevoked: true }),
      Response.json({ interrupted: false, approvalRevoked: false }),
    ];
    const env = {
      HARNESS_AUTH_TOKEN: authToken,
      HARNESS: { fetch: async () => responses.shift()! },
    } as unknown as Env;
    const args = {
      sessionId: "sess-1",
      threadKey: "slack:C1:1.2",
      executionId: EXEC_A,
    };

    await expect(interruptHarnessTurn(env, args)).resolves.toEqual({ accepted: false, interrupted: false });
    await expect(interruptHarnessTurn(env, args)).resolves.toEqual({ accepted: false, interrupted: false });
    await expect(interruptHarnessTurn(env, args)).resolves.toEqual({ accepted: false, interrupted: false });
    await expect(interruptHarnessTurn(env, args)).resolves.toEqual({
      accepted: true,
      interrupted: false,
      approvalRevoked: false,
    });
  });

  it("rejects an unauthenticated interrupt before container allocation", async () => {
    const fake = fakeNamespace();
    const response = await routeHarnessRequest(new Request("https://harness/interrupt", {
      method: "POST",
      body: JSON.stringify({ sessionId: "sess-1", executionId: EXEC_A, threadKey: "slack:C1:1.2" }),
    }), fake.namespace, authToken);
    expect(response.status).toBe(401);
    expect(fake.getByName).not.toHaveBeenCalled();
  });

  it("allows the approved execution during its stream and revokes it before done is delivered", async () => {
    let releaseDone!: () => void;
    let currentScope: GithubApprovalScope | undefined;
    const approvalAllowlist = {
      hosts: new Set(["github.com"]),
      orgs: new Set(["acme"]),
    };
    const approvedTurn = {
      ...validTurn,
      repo: { url: "https://github.com/acme/widget.git" },
      remoteGitApproved: true,
    };
    const attempt = {
      host: "github.com",
      method: "GET",
      pathname: "/acme/widget.git/info/refs",
      search: "?service=git-receive-pack",
      executionId: EXEC_A,
    };
    const doneReady = new Promise<void>((resolve) => (releaseDone = resolve));
    const startAndWaitForPorts = vi.fn(async () => undefined);
    const setTurnApproval = vi.fn(async (body: Record<string, unknown>) => {
      currentScope = buildApprovalScope(body, approvalAllowlist);
    });
    const clearTurnApproval = vi.fn(async (executionId: string) => {
      if (currentScope?.executionId !== executionId) return false;
      currentScope = undefined;
      return true;
    });
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"kind":"output","payload":{"text":"working"}}\n'));
        void doneReady.then(() => {
          controller.enqueue(new TextEncoder().encode('{"kind":"done","payload":{"ok":true}}\n'));
          controller.close();
        });
      },
    }), { headers: { "content-type": "application/x-ndjson" } }));
    const namespace = {
      getByName: () => ({ startAndWaitForPorts, setTurnApproval, clearTurnApproval, fetch }),
    } satisfies HarnessContainerNamespace;
    const response = await routeHarnessRequest(new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(approvedTurn),
    }), namespace, authToken, {
      allowedHosts: new Set(["github.com"]),
      allowedOrgs: new Set(["acme"]),
    });
    const reader = response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"output"');
    expect(authorizeGithubWrite(attempt, currentScope)).toBe(true);
    releaseDone();
    const terminal = await reader.read();
    expect(new TextDecoder().decode(terminal.value)).toContain('"kind":"done"');
    expect(authorizeGithubWrite(attempt, currentScope)).toBe(false);
  });

  it("does not let stale execution A cleanup revoke newer execution B", async () => {
    let currentExecution: string | undefined;
    const setTurnApproval = vi.fn(async (body: Record<string, unknown>) => {
      currentExecution = body.executionId as string;
    });
    const clearTurnApproval = vi.fn(async (executionId: string) => {
      if (currentExecution !== executionId) return false;
      currentExecution = undefined;
      return true;
    });
    const responses = [
      new Response(new ReadableStream({ start() {} })),
      new Response('{"kind":"output","payload":{"text":"B active"}}\n'),
    ];
    const stub = {
      startAndWaitForPorts: async () => undefined,
      setTurnApproval,
      clearTurnApproval,
      fetch: vi.fn(async () => responses.shift()!),
    };
    const namespace = { getByName: () => stub } satisfies HarnessContainerNamespace;
    const makeRequest = (executionId: string) => new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ ...validTurn, executionId }),
    });
    const responseA = await routeHarnessRequest(makeRequest(EXEC_A), namespace, authToken);
    const responseB = await routeHarnessRequest(makeRequest(EXEC_B), namespace, authToken);
    expect(currentExecution).toBe(EXEC_B);

    await responseA.body!.cancel("A disconnected late");
    expect(currentExecution).toBe(EXEC_B);
    expect(clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
    await responseB.body!.cancel();
    expect(currentExecution).toBeUndefined();
  });

  it("revokes approval on downstream cancel, upstream stream error, start error, and fetch error", async () => {
    const cancelFake = fakeNamespace(new Response(new ReadableStream({ start() {} })));
    const request = () => new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(validTurn),
    });
    const cancelled = await routeHarnessRequest(request(), cancelFake.namespace, authToken);
    await cancelled.body!.cancel("client left");
    expect(cancelFake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);

    const streamErrorFake = fakeNamespace(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("upstream broke")); },
    })));
    const errored = await routeHarnessRequest(request(), streamErrorFake.namespace, authToken);
    await expect(errored.text()).rejects.toThrow("upstream broke");
    expect(streamErrorFake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);

    const startErrorFake = fakeNamespace();
    startErrorFake.startAndWaitForPorts.mockRejectedValueOnce(new Error("container start failed"));
    await expect(routeHarnessRequest(request(), startErrorFake.namespace, authToken)).rejects.toThrow("container start failed");
    expect(startErrorFake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);

    const fetchErrorFake = fakeNamespace();
    fetchErrorFake.fetch.mockRejectedValueOnce(new Error("container fetch failed"));
    await expect(routeHarnessRequest(request(), fetchErrorFake.namespace, authToken)).rejects.toThrow("container fetch failed");
    expect(fetchErrorFake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
  });

  it("revokes and exits when the request aborts during container start", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<undefined>((resolve) => {
      releaseStart = () => resolve(undefined);
    });
    const fake = fakeNamespace();
    fake.startAndWaitForPorts.mockImplementationOnce(() => startGate);
    const controller = new AbortController();
    const pending = routeHarnessRequest(new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(validTurn),
      signal: controller.signal,
    }), fake.namespace, authToken);

    await vi.waitFor(() => expect(fake.startAndWaitForPorts).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
    expect(fake.fetch).not.toHaveBeenCalled();

    releaseStart();
    await Promise.resolve();
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("revokes and never wraps a late response when abort lands during fetch", async () => {
    let releaseFetch!: (response: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => { releaseFetch = resolve; });
    const fake = fakeNamespace();
    fake.fetch.mockImplementationOnce(() => fetchGate);
    const controller = new AbortController();
    const pending = routeHarnessRequest(new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(validTurn),
      signal: controller.signal,
    }), fake.namespace, authToken);

    await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);

    releaseFetch(new Response('{"kind":"done"}\n'));
    await Promise.resolve();
    expect(fake.clearTurnApproval).toHaveBeenCalledTimes(1);
  });

  it("revokes immediately when the container rejects admission before a stream is consumed", async () => {
    const fake = fakeNamespace(Response.json({ error: "execution_in_flight" }, { status: 409 }));
    const response = await routeHarnessRequest(new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(validTurn),
    }), fake.namespace, authToken);
    expect(response.status).toBe(409);
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
  });

  it("revokes before an NDJSON error while preserving its following single done", async () => {
    const fake = fakeNamespace(new Response(
      '{"kind":"error","payload":{"message":"failed"}}\n' +
      '{"kind":"done","payload":{"ok":false}}\n',
      { headers: { "content-type": "application/x-ndjson" } },
    ));
    const response = await routeHarnessRequest(new Request("https://harness/turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(validTurn),
    }), fake.namespace, authToken);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"kind":"error"');
    expect(fake.clearTurnApproval).toHaveBeenCalledWith(EXEC_A);
    const rest = new TextDecoder().decode((await reader.read()).value);
    expect(rest).toContain('"kind":"done"');
    expect(`${first}${rest}`.match(/"kind":"done"/g)).toHaveLength(1);
  });

  it("rejects malformed requests before allocating a container", async () => {
    const fake = fakeNamespace();
    const response = await routeHarnessRequest(
      new Request("https://harness/turn", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ ...validTurn, sessionId: "../escape" }),
      }),
      fake.namespace,
      authToken,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_session_id" });
    expect(fake.getByName).not.toHaveBeenCalled();
    expect(fake.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it.each([
    ["execution id", { executionId: "../escape" }, "invalid_execution_id"],
    ["forwarded message id", { forwardedMessageId: "slack/C1/1" }, "invalid_forwarded_message_id"],
    ["thread key", { threadKey: "slack/C1" }, "invalid_thread_key"],
    ["model", { model: "opus; rm -rf /" }, "invalid_model"],
    ["empty input", { inputLines: [""] }, "invalid_input_lines"],
    ["input line type", { inputLines: [42] }, "invalid_input_lines"],
    ["requester context", { requesterContext: "x".repeat(16_385) }, "invalid_context"],
    ["transcript", { transcript: "x".repeat(256 * 1024 + 1) }, "invalid_context"],
    ["repo", { repo: { url: "https://github.com/other/repo" } }, "repo_not_allowed"],
    ["coding policy", { codingTask: "yes" }, "invalid_git_policy"],
    ["approval policy", { createPullRequest: true }, "remote_git_not_approved"],
  ])("rejects invalid %s before allocation", async (_label, patch, error) => {
    const fake = fakeNamespace();
    const response = await routeHarnessRequest(
      new Request("https://harness/turn", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ ...validTurn, ...patch }),
      }),
      fake.namespace,
      authToken,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(fake.getByName).not.toHaveBeenCalled();
    expect(fake.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it("rejects a 1.1 MiB body before allocation or start", async () => {
    const fake = fakeNamespace();
    const response = await routeHarnessRequest(
      new Request("https://harness/turn", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: "x".repeat(Math.ceil(MAX_TURN_BODY_BYTES * 1.1)),
      }),
      fake.namespace,
      authToken,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "body_too_large" });
    expect(fake.getByName).not.toHaveBeenCalled();
    expect(fake.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "wrong-secret"])(
    "rejects bearer %s before allocating or starting a container",
    async (bearer) => {
      const fake = fakeNamespace();
      const headers = new Headers({ "content-type": "application/json" });
      if (bearer !== undefined) headers.set("Authorization", `Bearer ${bearer}`);
      const response = await routeHarnessRequest(
        new Request("https://harness/turn", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...validTurn, sessionId: "sess-unauthorized" }),
        }),
        fake.namespace,
        authToken,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(fake.getByName).not.toHaveBeenCalled();
      expect(fake.startAndWaitForPorts).not.toHaveBeenCalled();
      expect(fake.fetch).not.toHaveBeenCalled();
    },
  );

  it("serves frontend health without starting a container", async () => {
    const fake = fakeNamespace();
    const response = await routeHarnessRequest(
      new Request("https://harness/health"),
      fake.namespace,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, worker: "opentag-harness" });
    expect(fake.getByName).not.toHaveBeenCalled();
  });
});
