#!/usr/bin/env bash
# Full end-to-end verification for the Durable Object SQLite StateStore.
#
# 1. Typecheck
# 2. StateStore conformance on node:sqlite (fast engine)
# 3. StateStore conformance + DO checks inside workerd (real runtime)
# 4. Real createBot driving the store (built from CopilotKit monorepo source)
# 5. Live wrangler dev: GET /health + GET /debug/store through a real DO
#
# Usage: bash scripts/e2e-full.sh   (from edge/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
failures=0
step() { echo -e "\n${GREEN}==>${NC} $1"; }
ok() { echo -e "${GREEN}OK${NC}  $1"; }
bad() { echo -e "${RED}FAIL${NC} $1"; failures=$((failures + 1)); }

step "1/5  Typecheck"
if npx tsc --noEmit -p tsconfig.json; then ok "tsc --noEmit"; else bad "tsc --noEmit"; fi

step "2/5  Engine suite (node:sqlite)"
if npx vitest run 2>&1 | tee /tmp/e2e-node.log; then
  ok "vitest (node)"
else
  bad "vitest (node) — see /tmp/e2e-node.log"
fi

step "3/5  Durable Object suite (workerd)"
if npx vitest run --config vitest.workers.bot-store.config.ts 2>&1 | tee /tmp/e2e-workerd.log; then
  ok "vitest (workerd)"
else
  bad "vitest (workerd) — see /tmp/e2e-workerd.log"
fi

step "4/5  createBot integration (source-built @copilotkit/bot)"
CK="${COPILOTKIT_MONOREPO:-/tmp/ckit}"
BB=/tmp/opentag-e2e-bot-build
rm -rf "$BB" && mkdir -p "$BB" && cd "$BB"

if [[ ! -f "$CK/packages/bot/package.json" ]]; then
  bad "CopilotKit monorepo not found at $CK — set COPILOTKIT_MONOREPO or clone to /tmp/ckit"
else
  npm init -y >/dev/null 2>&1
  npm pkg set type=module >/dev/null 2>&1
  npm i -D typescript@5.6.3 @types/node@22.10.0 >/dev/null 2>&1
  npm i @copilotkit/core@1.62.1 @copilotkit/shared@1.62.1 \
    @ag-ui/client@0.0.57 @ag-ui/core@0.0.57 zod-to-json-schema@3.24.1 zod@3.25.76 >/dev/null 2>&1

  mkdir -p src/botui src/bot node_modules/@copilotkit/bot-ui node_modules/@copilotkit/bot
  cp -r "$CK"/packages/bot-ui/src/* src/botui/
  cp -r "$CK"/packages/bot/src/* src/bot/
  find src -name '*.test.ts' -o -name '*.test.tsx' | xargs rm -f 2>/dev/null || true

  cat > node_modules/@copilotkit/bot-ui/package.json <<'JSON'
{"name":"@copilotkit/bot-ui","version":"0.1.0","type":"module","main":"./dist/index.js",
 "exports":{".":{"import":"./dist/index.js"},"./jsx-runtime":{"import":"./dist/jsx-runtime.js"},
 "./jsx-dev-runtime":{"import":"./dist/jsx-dev-runtime.js"}}}
JSON
  cat > tsconfig.botui.json <<JSON
{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","target":"es2022",
 "jsx":"react-jsx","jsxImportSource":"@copilotkit/bot-ui","skipLibCheck":true,"noEmitOnError":false,
 "outDir":"node_modules/@copilotkit/bot-ui/dist","rootDir":"src/botui"},
 "include":["src/botui/**/*.ts","src/botui/**/*.tsx"]}
JSON
  npx tsc -p tsconfig.botui.json 2>/dev/null || true

  cat > node_modules/@copilotkit/bot/package.json <<'JSON'
{"name":"@copilotkit/bot","version":"0.1.0","type":"module","main":"./dist/index.js",
 "exports":{".":{"import":"./dist/index.js"},
 "./testing/fake-adapter":{"import":"./dist/testing/fake-adapter.js"},
 "./testing/fake-agent":{"import":"./dist/testing/fake-agent.js"}}}
JSON
  cat > tsconfig.bot.json <<JSON
{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","target":"es2022",
 "lib":["es2022"],"jsx":"react-jsx","jsxImportSource":"@copilotkit/bot-ui",
 "skipLibCheck":true,"noEmitOnError":false,"types":["node"],
 "outDir":"node_modules/@copilotkit/bot/dist","rootDir":"src/bot"},
 "include":["src/bot/**/*.ts","src/bot/**/*.tsx"]}
JSON
  npx tsc -p tsconfig.bot.json 2>/dev/null || true

  # vitest stub: main entry re-exports a vitest-dependent helper
  mkdir -p node_modules/vitest
  echo '{"name":"vitest","version":"0.0.0-stub","type":"module","exports":{".":"./index.js"}}' > node_modules/vitest/package.json
  echo 'export const describe=()=>{},it=()=>{},expect=()=>{},beforeEach=()=>{},afterEach=()=>{};' > node_modules/vitest/index.js

  # Compile edge store engine (same code the DO runs)
  mkdir -p store-src store-dist
  cp "$ROOT"/src/store/sql.ts "$ROOT"/src/store/schema.ts \
     "$ROOT"/src/store/sql-state-engine.ts "$ROOT"/src/store/state-store-contract.ts store-src/
  cp "$ROOT"/test/sqlite-state-store.ts store-src/
  sed -i 's|../src/store/|./|g' store-src/sqlite-state-store.ts
  cat > tsconfig.store.json <<JSON
{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","target":"es2022",
 "lib":["es2022"],"skipLibCheck":true,"noEmitOnError":false,
 "outDir":"store-dist","rootDir":"store-src","types":["node"]},
 "include":["store-src/**/*.ts"]}
JSON
  npx tsc -p tsconfig.store.json 2>/dev/null || true

  cat > integration.mjs <<'MJS'
import { createBot } from "@copilotkit/bot";
import { FakeAdapter } from "@copilotkit/bot/testing/fake-adapter";
import { FakeAgent } from "@copilotkit/bot/testing/fake-agent";
import { makeSqliteStateStore } from "./store-dist/sqlite-state-store.js";

let n = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) n++; };

const { store } = makeSqliteStateStore();
const adapter = new FakeAdapter();
const bot = createBot({ adapters: [adapter], agent: () => new FakeAgent([]), store: { adapter: store } });
bot.onMention(async ({ thread }) => {
  const prev = (await thread.state()) ?? { hits: 0 };
  await thread.setState({ hits: prev.hits + 1 });
});
await bot.start();
const sink = adapter.getSink();
await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "hi", platform: "fake", eventId: "e1" });
check("thread.setState -> kv", JSON.stringify(await store.kv.get("threadstate:C1")) === JSON.stringify({ hits: 1 }));
const lk = await store.lock.acquire("turn:C1");
check("turn lock released", lk !== null);
if (lk) await store.lock.release("turn:C1", lk.token);
await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "dup", platform: "fake", eventId: "e1" });
check("dedup drops replay", JSON.stringify(await store.kv.get("threadstate:C1")) === JSON.stringify({ hits: 1 }));
await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "new", platform: "fake", eventId: "e2" });
check("new event advances", JSON.stringify(await store.kv.get("threadstate:C1")) === JSON.stringify({ hits: 2 }));
await bot.stop();
process.exit(n === 0 ? 0 : 1);
MJS

  if [[ ! -f node_modules/@copilotkit/bot/dist/index.js ]]; then
    bad "failed to build @copilotkit/bot from $CK"
  elif [[ ! -f store-dist/sqlite-state-store.js ]]; then
    bad "failed to compile store engine"
  elif NODE_ENV=test node integration.mjs 2>&1 | tee /tmp/e2e-createbot.log; then
    ok "createBot + SQLite StateStore"
  else
    bad "createBot integration — see /tmp/e2e-createbot.log"
  fi
fi

cd "$ROOT"

step "5/5  Live wrangler dev (/health + /debug/store)"
PORT=18765
WRANGLER_LOG=/tmp/e2e-wrangler.log
rm -f "$WRANGLER_LOG"

# Start wrangler in background; kill on exit
npx wrangler dev --config wrangler.bot-store.toml --port "$PORT" --local >"$WRANGLER_LOG" 2>&1 &
WR_PID=$!
cleanup_wrangler() { kill "$WR_PID" 2>/dev/null || true; wait "$WR_PID" 2>/dev/null || true; }
trap cleanup_wrangler EXIT

# Wait for server (up to 45s)
ready=0
for i in $(seq 1 45); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  bad "wrangler dev did not become ready — tail $WRANGLER_LOG"
  tail -30 "$WRANGLER_LOG" || true
else
  HEALTH=$(curl -sf "http://127.0.0.1:${PORT}/health")
  if echo "$HEALTH" | grep -q '"ok":true'; then ok "/health → $HEALTH"; else bad "/health unexpected: $HEALTH"; fi

  DEBUG=$(curl -sf "http://127.0.0.1:${PORT}/debug/store")
  if echo "$DEBUG" | grep -q '"kv"' && echo "$DEBUG" | grep -q '"dedup"' && echo "$DEBUG" | grep -q '"queue"'; then
    ok "/debug/store round-trip through live DO"
    echo "       $DEBUG" | head -c 200; echo "..."
  else
    bad "/debug/store unexpected: $DEBUG"
  fi
fi

trap - EXIT
cleanup_wrangler

echo
if [[ "$failures" -eq 0 ]]; then
  echo -e "${GREEN}ALL E2E CHECKS PASSED${NC}"
  exit 0
else
  echo -e "${RED}$failures E2E CHECK(S) FAILED${NC}"
  exit 1
fi
