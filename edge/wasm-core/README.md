# wasm-core (TinyGo)

Intent classifier compiled to WASM for the `opentag-wasm-dispatch` Worker.

This is an optional research dispatch component. It is not Slack ingress, not
required by `edge-ci`, and not part of the normal `opentag-bot` deploy.

## Contract

`POST /dispatch` body `{ text, userId?, channelId? }` →
`{ intent, confidence, extractedObjective }`

## Build (requires TinyGo + wasm-opt)

```bash
# from edge/
npm run build:wasm
```

Until TinyGo is available, `workers/wasm-dispatch/src/index.ts` serves the same
contract as a TypeScript fallback so Tracks A/B can integrate via the
`WASM_DISPATCH` service binding.

## Constraints

- No goroutines
- No WASI / `os.Getenv` / file I/O
- All inputs via HTTP body
