import { describe, expect, it, vi } from "vitest";
import type { Renderable } from "@copilotkit/channels-ui";
import {
  awaitRemoteGitApproval,
  isRepositoryCodingIntent,
  repositoryForDisplay,
  requesterForApproval,
} from "../src/hitl/remote-git-approval.js";
import { persistHitlChoice } from "../src/hitl/durable-choice.js";
import type { StateStore } from "../src/store/state-store-contract.js";

function memoryStore(): StateStore {
  const values = new Map<string, unknown>();
  return {
    kv: {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
    list: {
      async append() { return 0; },
      async range() { return []; },
      async trim() {},
      async delete() {},
    },
    lock: {
      async acquire() { return { token: "t" }; },
      async release() {},
    },
    dedup: { async seen() { return false; } },
    queue: {
      async enqueue() { return 0; },
      async dequeue() { return undefined; },
      async depth() { return 0; },
    },
  };
}

function waitingThread(conversationKey = "C1::111.222") {
  return {
    conversationKey,
    awaitChoice: vi.fn(async (_ui: Renderable) => new Promise<never>(() => {})),
  };
}

describe("remote git approval", () => {
  it.each([
    ["make a script to normalize these files", true],
    ["Please fix the worker test", true],
    ["repair the router race", true],
    ["resolve the failing check", true],
    ["implement the endpoint", true],
    ["change the config", true],
    ["add and remove a dependency", true],
    ["refactor the worker", true],
    ["test the build", true],
    ["build a release script", true],
    ["script this migration", true],
    ["config the worker", true],
    ["deploy the service", true],
    ["open a PR for these changes", true],
    ["How does this script work?", false],
    ["review the API implementation", false],
    ["analyze why the tests fail", false],
    ["summarize the repository structure", false],
    ["inspect the deploy script", false],
    ["what should we fix in the worker?", true],
    ["take care of the repository", true],
  ])("classifies %s consistently as coding=%s", (text, expected) => {
    expect(isRepositoryCodingIntent(text)).toBe(expected);
  });

  it("renders safe, requester-specific repository labels", () => {
    expect(repositoryForDisplay("https://token@github.com/acme/widget.git")).toBe(
      "github.com/acme/widget.git",
    );
    expect(requesterForApproval({ handle: "octocat" })).toBe("@octocat");
    expect(requesterForApproval({ id: "U123" })).toBe("<@U123>");
  });

  it("approves across isolates only through the stable affirmative choice", async () => {
    const store = memoryStore();
    const thread = waitingThread("waiting-isolate");
    const pending = awaitRemoteGitApproval(thread, store, {
      repository: "https://github.com/acme/widget.git",
      requester: "@requester",
      choiceId: "git-choice-approve",
      timeoutMs: 1_000,
      pollMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    await persistHitlChoice(store, "click-isolate", {
      confirmed: true,
      choiceId: "git-choice-approve",
    });

    await expect(pending).resolves.toEqual({
      remoteGitApproved: true,
      createPullRequest: true,
    });
    expect(thread.awaitChoice).toHaveBeenCalledTimes(1);
  });

  it("keeps both capabilities false for a cross-isolate cancel", async () => {
    const store = memoryStore();
    const pending = awaitRemoteGitApproval(waitingThread("waiting-isolate"), store, {
      repository: "https://github.com/acme/widget.git",
      requester: "@requester",
      choiceId: "git-choice-cancel",
      timeoutMs: 1_000,
      pollMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    await persistHitlChoice(store, "click-isolate", {
      confirmed: false,
      choiceId: "git-choice-cancel",
    });

    await expect(pending).resolves.toEqual({
      remoteGitApproved: false,
      createPullRequest: false,
    });
  });

  it("fails closed on timeout and on a mismatched stable choice id", async () => {
    await expect(
      awaitRemoteGitApproval(waitingThread(), memoryStore(), {
        repository: "https://github.com/acme/widget.git",
        requester: "@requester",
        choiceId: "git-choice-timeout",
        timeoutMs: 20,
        pollMs: 5,
      }),
    ).resolves.toEqual({ remoteGitApproved: false, createPullRequest: false });

    const mismatched = {
      conversationKey: "C1::111.222",
      awaitChoice: async <T>() =>
        ({ confirmed: true, choiceId: "old-choice" }) as T,
    };
    await expect(
      awaitRemoteGitApproval(mismatched, memoryStore(), {
        repository: "https://github.com/acme/widget.git",
        requester: "@requester",
        choiceId: "current-choice",
      }),
    ).resolves.toEqual({ remoteGitApproved: false, createPullRequest: false });
  });
});
