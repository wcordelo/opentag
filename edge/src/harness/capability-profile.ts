export type HarnessCapabilityProfile = {
  version: 1;
  harnessType: "claudecode" | "claudex" | "nanocodex";
  provider: "anthropic" | "openai";
  mode: "cli" | "native_responses";
  model?: string;
  modelAllowed: boolean;
  source: "static" | "provider_reported";
  capabilities: {
    text: true;
    streaming: true;
    toolCalls: boolean;
    images: boolean;
    persistentCheckpoint: boolean;
    fullHistoryReplay: boolean;
    codingWorkspace: boolean;
  };
};

export function harnessModelAllowed(
  harnessType: HarnessCapabilityProfile["harnessType"],
  model: string | undefined,
): boolean {
  if (!model) return true;
  const isGpt = /^gpt-/i.test(model);
  return harnessType === "claudecode" ? !isGpt : isGpt;
}

export function resolveHarnessCapabilityProfile(args: {
  harnessType: HarnessCapabilityProfile["harnessType"];
  model?: string;
  nativeResponses?: boolean;
  source?: "static" | "provider_reported";
}): HarnessCapabilityProfile {
  const native = args.harnessType === "nanocodex" && args.nativeResponses === true;
  return {
    version: 1,
    harnessType: args.harnessType,
    provider: args.harnessType === "claudecode" ? "anthropic" : "openai",
    mode: native ? "native_responses" : "cli",
    ...(args.model ? { model: args.model } : {}),
    modelAllowed: harnessModelAllowed(args.harnessType, args.model),
    source: args.source ?? "static",
    capabilities: {
      text: true,
      streaming: true,
      toolCalls: !native,
      images: args.harnessType === "claudecode" && !native,
      persistentCheckpoint: args.harnessType === "nanocodex",
      fullHistoryReplay: args.harnessType === "nanocodex",
      codingWorkspace: !native,
    },
  };
}
