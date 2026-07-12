declare module "@copilotkit/bot" {
  export function createBot(options: unknown): {
    handle?: (input: unknown) => Promise<unknown>;
  };
}
