import process from "node:process";

export const OPENTAG_BOT_PRODUCTION_DEPLOY_MESSAGE =
  "Production deploys of opentag-bot come from berendo-labs/cosmos; see docs/operations.md";

/** Exit non-zero before any wrangler deploy of wrangler.bot.toml from opentag. */
export function blockOpentagBotProductionDeploy() {
  process.stderr.write(`${OPENTAG_BOT_PRODUCTION_DEPLOY_MESSAGE}\n`);
  process.exit(1);
}
