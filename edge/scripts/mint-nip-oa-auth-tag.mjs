#!/usr/bin/env node
/**
 * Local-only NIP-OA auth-tag mint for OpenTag Path 2 live exercise.
 *
 * NEVER paste OWNER_SECRET or the printed tag into chat.
 * Run on the owner machine; pipe stdout into `wrangler secret put`.
 *
 * Usage:
 *   OWNER_SECRET=<64-hex> \
 *   node scripts/mint-nip-oa-auth-tag.mjs <agent-pubkey-hex> [conditions]
 *
 * Agent pubkey is REQUIRED (no default). A silent default previously pointed
 * at a non-deployed M1_TEST_SIGNER and broke Path-2 on remint.
 * Live M1 signer on opentag-bot (2026-08-01): 
 *   292a282b30fd3fbe7cac2a956a632273ce4bb46aef8bc822dc9167e7d985ca75
 *
 * Output: single-line JSON ["auth","<owner-pubkey>","<conditions>","<sig>"]
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const HEX64 = /^[0-9a-f]{64}$/;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const ownerRaw = (process.env.OWNER_SECRET || "").trim().toLowerCase();
if (!HEX64.test(ownerRaw)) {
  die(
    "OWNER_SECRET must be a 64-char lowercase hex private key (nsec not accepted here).",
  );
}

const agentArg = process.argv[2];
if (!agentArg) {
  die(
    "usage: OWNER_SECRET=<64-hex> node scripts/mint-nip-oa-auth-tag.mjs <agent-pubkey-hex> [conditions]\n" +
      "agent pubkey is required (no default — pass the live BUZZ_OPEN_TAG_SIGNER_SECRET pubkey).",
  );
}
const agent = agentArg.trim().toLowerCase();
if (!HEX64.test(agent)) {
  die("agent pubkey must be 64-char lowercase hex");
}

const conditions = process.argv[3] ?? "";
if (/\s/.test(conditions)) {
  die("conditions must not contain whitespace (NIP-OA)");
}

const ownerSecret = hexToBytes(ownerRaw);
const ownerPubkey = bytesToHex(schnorr.getPublicKey(ownerSecret));
if (ownerPubkey === agent) {
  die("owner and agent pubkeys must differ (self-attestation rejected)");
}

const preimage = new TextEncoder().encode(
  `nostr:agent-auth:${agent}:${conditions}`,
);
const message = sha256(preimage);
const sig = bytesToHex(schnorr.sign(message, ownerSecret));

const tag = JSON.stringify(["auth", ownerPubkey, conditions, sig]);
process.stdout.write(`${tag}\n`);
