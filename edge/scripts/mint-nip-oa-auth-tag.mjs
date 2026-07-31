#!/usr/bin/env node
/**
 * Local-only NIP-OA auth-tag mint for OpenTag Path 2 live exercise.
 *
 * NEVER paste OWNER_SECRET or the printed tag into chat.
 * Run on the owner machine; pipe stdout into `wrangler secret put`.
 *
 * Usage:
 *   OWNER_SECRET=<64-hex-or-nsec-not-supported-use-hex> \
 *   node scripts/mint-nip-oa-auth-tag.mjs [agent-pubkey-hex] [conditions]
 *
 * Defaults:
 *   agent   = OpenTag M1 test signer 3c56bed9…
 *   conditions = "" (empty — NIP-OA allows it)
 *
 * Output: single-line JSON ["auth","<owner-pubkey>","<conditions>","<sig>"]
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const M1_TEST_SIGNER =
  "3c56bed9fd8ada962e6040cf971d759c8f8f48ef3e18e02451e4c27734128194";

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

const agent = (process.argv[2] || M1_TEST_SIGNER).trim().toLowerCase();
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
