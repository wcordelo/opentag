/**
 * Legacy Node Socket Mode Slack bot — REMOVED.
 *
 * Claude Tag on Cloudflare is the only Slack ingress:
 *   cd edge && npm run dev
 * Agent backend (AG-UI):
 *   pnpm runtime
 *
 * See PRODUCT.md and edge/README.md.
 */
console.error(`
OpenTag Slack bot no longer runs via \`pnpm start\` / Socket Mode.

  Slack ingress:  cd edge && npm run dev
  Agent runtime:  pnpm runtime
  Research tasks: cd edge && npm run dev:research

Docs: PRODUCT.md · edge/README.md
`);
process.exit(1);
