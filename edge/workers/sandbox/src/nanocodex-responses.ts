export type NanocodexInputText = {
  type: "input_text";
  text: string;
};

export type NanocodexUserInput = {
  role: "user";
  content: string | readonly NanocodexInputText[];
};

export type NanocodexResponseItem = {
  type: string;
  [key: string]: unknown;
};

export type NanocodexHistoryItem = NanocodexUserInput | NanocodexResponseItem;

export type NanocodexResponsesRequest = {
  model: string;
  input: readonly NanocodexHistoryItem[];
  previous_response_id?: string;
  instructions?: string;
  store: boolean;
  stream: true;
  reasoning?: { effort?: string };
  text?: { verbosity?: "low" | "medium" | "high" };
};

export type NanocodexResponseEnvelope = {
  id: string;
  status: "completed" | "failed" | "incomplete" | string;
  output: NanocodexResponseItem[];
  error?: { code?: string; message?: string } | null;
};

export type NanocodexResponsesEvent =
  | { type: "response.created"; response?: Partial<NanocodexResponseEnvelope> }
  | { type: "response.output_text.delta"; delta: string; item_id?: string; output_index?: number }
  | { type: "response.output_item.done"; item: NanocodexResponseItem; output_index?: number }
  | { type: "response.completed"; response: NanocodexResponseEnvelope }
  | { type: "response.failed"; response?: Partial<NanocodexResponseEnvelope>; error?: { code?: string; message?: string } }
  | { type: "error"; code?: string; message?: string }
  | { type: string; [key: string]: unknown };

export type NanocodexProviderState = {
  version: 1;
  previousResponseId?: string;
  history: NanocodexHistoryItem[];
  checkpoint: "healthy" | "replay_required";
};

export type NanocodexResponsesRunResult = {
  responseId: string;
  outputItems: NanocodexResponseItem[];
  text: string;
  replayed: boolean;
};

export class NanocodexResponsesError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly checkpointFailure: boolean;

  constructor(code: string, options: { status?: number; checkpointFailure?: boolean } = {}) {
    super(code);
    this.name = "NanocodexResponsesError";
    this.status = options.status;
    this.code = code;
    this.checkpointFailure = options.checkpointFailure === true;
  }
}

function responseErrorCode(value: unknown): string {
  if (typeof value !== "string") return "responses_error";
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
  return normalized || "responses_error";
}

function isCheckpointFailureCode(code: string): boolean {
  const normalized = code.toLowerCase();
  return normalized.includes("checkpoint")
    || normalized.includes("invalid_response_id")
    || /previous.*response.*(not|unknown|invalid|missing).*found?/.test(normalized)
    || /response.*(not|unknown|invalid).*found?/.test(normalized)
    || /responses_http_(400|404|409)$/.test(normalized);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseEnvelope(value: unknown): NanocodexResponseEnvelope | undefined {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.status !== "string") return undefined;
  const output = Array.isArray(value.output)
    ? value.output.filter((item): item is NanocodexResponseItem => isObject(item) && typeof item.type === "string")
    : [];
  return {
    id: value.id,
    status: value.status,
    output,
    ...(isObject(value.error) ? { error: value.error as NanocodexResponseEnvelope["error"] } : {}),
  };
}

function parseEvent(value: unknown): NanocodexResponsesEvent | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  return value as NanocodexResponsesEvent;
}

export function parseNanocodexResponsesSse(text: string): NanocodexResponsesEvent[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: NanocodexResponsesEvent[] = [];
  for (const frame of normalized.split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = parseEvent(JSON.parse(data));
      if (event) events.push(event);
    } catch {
    }
  }
  return events;
}

async function* readNanocodexResponsesSse(response: Response): AsyncGenerator<NanocodexResponsesEvent> {
  if (!response.body) throw new NanocodexResponsesError("responses_body_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const event of parseNanocodexResponsesSse(`${frame}\n\n`)) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  for (const event of parseNanocodexResponsesSse(buffer)) yield event;
}

export type NanocodexResponsesClientOptions = {
  apiBaseUrl?: string;
  apiKey?: string;
  fetcher?: typeof fetch;
};

export class NanocodexResponsesClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: NanocodexResponsesClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
  }

  async stream(
    request: NanocodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<NanocodexResponsesEvent>> {
    const headers = new Headers({
      accept: "text/event-stream",
      "content-type": "application/json",
    });
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    const response = await this.fetcher(`${this.apiBaseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      let code = `responses_http_${response.status}`;
      try {
        const payload = await response.clone().json() as { error?: { code?: unknown; type?: unknown } };
        code = responseErrorCode(payload.error?.code ?? payload.error?.type ?? code);
      } catch {
      }
      throw new NanocodexResponsesError(code, {
        status: response.status,
        checkpointFailure: Boolean(request.previous_response_id) && (response.status === 400 || response.status === 404 || response.status === 409),
      });
    }
    return readNanocodexResponsesSse(response);
  }
}

function inputItem(input: string | NanocodexUserInput): NanocodexUserInput {
  return typeof input === "string" ? { role: "user", content: input } : input;
}

function outputText(items: readonly NanocodexResponseItem[]): string {
  return items.flatMap((item) => {
    if (item.type !== "message" || !Array.isArray(item.content)) return [];
    return item.content.flatMap((content) => {
      if (!isObject(content) || content.type !== "output_text" || typeof content.text !== "string") return [];
      return [content.text];
    });
  }).join("");
}

function cloneState(value: NanocodexProviderState): NanocodexProviderState {
  return JSON.parse(JSON.stringify(value)) as NanocodexProviderState;
}

function boundedState(value: NanocodexProviderState): NanocodexProviderState {
  const cloned = cloneState(value);
  if (new TextEncoder().encode(JSON.stringify(cloned)).byteLength > 2 * 1024 * 1024) {
    throw new NanocodexResponsesError("provider_state_too_large");
  }
  return cloned;
}

function validState(value: unknown): value is NanocodexProviderState {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.history) || value.history.length > 512) return false;
  if (value.previousResponseId !== undefined && typeof value.previousResponseId !== "string") return false;
  if (value.checkpoint !== "healthy" && value.checkpoint !== "replay_required") return false;
  return value.history.every((item) => {
    if (!isObject(item)) return false;
    if (item.type !== undefined) return typeof item.type === "string";
    return item.role === "user" && (typeof item.content === "string" || Array.isArray(item.content));
  });
}

export function parseNanocodexProviderState(value: unknown): NanocodexProviderState | undefined {
  if (!validState(value)) return undefined;
  try {
    return boundedState(value);
  } catch {
    return undefined;
  }
}

export class NanocodexResponsesSession {
  private state: NanocodexProviderState;

  constructor(
    private readonly client: NanocodexResponsesClient,
    private readonly options: { model: string; instructions?: string; store?: boolean; reasoningEffort?: string; textVerbosity?: "low" | "medium" | "high" },
    initialState?: NanocodexProviderState,
  ) {
    const parsedState = initialState ? parseNanocodexProviderState(initialState) : undefined;
    if (initialState && !parsedState) throw new NanocodexResponsesError("invalid_provider_state");
    this.state = parsedState
      ? parsedState
      : { version: 1, history: [], checkpoint: "replay_required" };
  }

  snapshot(): NanocodexProviderState {
    return boundedState(this.state);
  }

  async run(args: {
    input: string | NanocodexUserInput;
    signal?: AbortSignal;
    onEvent?: (event: NanocodexResponsesEvent) => void | Promise<void>;
  }): Promise<NanocodexResponsesRunResult> {
    const nextInput = inputItem(args.input);
    const fullInput = [...this.state.history, nextInput];
    const useCheckpoint = this.state.checkpoint === "healthy" && Boolean(this.state.previousResponseId);
    const request = (replay: boolean): NanocodexResponsesRequest => ({
      model: this.options.model,
      input: replay || !useCheckpoint ? fullInput : [nextInput],
      ...(replay || !useCheckpoint ? {} : { previous_response_id: this.state.previousResponseId }),
      ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
      store: this.options.store ?? true,
      stream: true,
      ...(this.options.reasoningEffort ? { reasoning: { effort: this.options.reasoningEffort } } : {}),
      ...(this.options.textVerbosity ? { text: { verbosity: this.options.textVerbosity } } : {}),
    });

    let replayed = false;
    let result: { response: NanocodexResponseEnvelope; outputItems: NanocodexResponseItem[]; text: string };
    const checkpointEvents: NanocodexResponsesEvent[] = [];
    try {
      result = await this.collect(request(false), useCheckpoint && args.onEvent
        ? {
            ...args,
            onEvent: async (event) => {
              checkpointEvents.push(event);
            },
          }
        : args);
      if (useCheckpoint && args.onEvent) {
        for (const event of checkpointEvents) await args.onEvent(event);
      }
    } catch (error) {
      if (!useCheckpoint || !(error instanceof NanocodexResponsesError) || !error.checkpointFailure) throw error;
      this.state.checkpoint = "replay_required";
      replayed = true;
      result = await this.collect(request(true), args);
    }

    if (result.response.status !== "completed") {
      throw new NanocodexResponsesError("responses_incomplete");
    }
    this.state = boundedState({
      version: 1,
      history: [...fullInput, ...result.outputItems],
      previousResponseId: result.response.id,
      checkpoint: "healthy",
    });
    return {
      responseId: result.response.id,
      outputItems: result.outputItems,
      text: result.text,
      replayed,
    };
  }

  private async collect(
    request: NanocodexResponsesRequest,
    args: { signal?: AbortSignal; onEvent?: (event: NanocodexResponsesEvent) => void | Promise<void> },
  ): Promise<{ response: NanocodexResponseEnvelope; outputItems: NanocodexResponseItem[]; text: string }> {
    const stream = await this.client.stream(request, args.signal);
    const outputItems: NanocodexResponseItem[] = [];
    const deltas: string[] = [];
    let completed: NanocodexResponseEnvelope | undefined;
    for await (const event of stream) {
      await args.onEvent?.(event);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") deltas.push(event.delta);
      if (event.type === "response.output_item.done" && isObject(event.item) && typeof event.item.type === "string") outputItems.push(event.item as NanocodexResponseItem);
      if (event.type === "response.failed" || event.type === "error") {
        const eventRecord = event as Record<string, unknown>;
        const eventError = isObject(eventRecord.error) ? eventRecord.error.code : undefined;
        const response = isObject(eventRecord.response) ? eventRecord.response : undefined;
        const responseError = response && isObject(response.error) ? response.error.code : undefined;
        const code = responseErrorCode(eventError ?? responseError ?? eventRecord.code ?? "responses_failed");
        throw new NanocodexResponsesError(code, { checkpointFailure: Boolean(request.previous_response_id) && isCheckpointFailureCode(code) });
      }
      if (event.type === "response.completed") {
        completed = responseEnvelope(event.response);
      }
    }
    if (!completed) throw new NanocodexResponsesError("responses_missing_completed");
    const finalItems = completed.output.length > 0 ? completed.output : outputItems;
    return {
      response: completed,
      outputItems: finalItems,
      text: deltas.join("") || outputText(finalItems),
    };
  }
}
