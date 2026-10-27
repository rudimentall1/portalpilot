import crypto from "node:crypto";
import fs from "node:fs";

export const PORTALDOT_TESTNET_RPC = "wss://test-node-v3.portaldot.dev";
export const PORTALDOT_TESTNET_GENESIS =
  "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const DECIMALS = 14;

function fail(message: string): never {
  throw new Error(message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function positiveInteger(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    fail(label + " must be a canonical positive integer string.");
  }
  return value;
}

function potToBaseUnits(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,14})?$/.test(value)) {
    fail("POT amount must be a canonical decimal string with at most 14 fractional digits.");
  }
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 10n ** BigInt(DECIMALS) +
    BigInt((fraction + "0".repeat(DECIMALS)).slice(0, DECIMALS));
  if (amount <= 0n) fail("POT amount must be greater than zero.");
  return amount.toString();
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("VERIGATE_BASE_URL must be a valid absolute URL."); }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback.has(url.hostname)))) {
    fail("Verigate URLs must use HTTPS, except loopback development URLs, and must not embed credentials.");
  }
  return url;
}

function verifyLocally(attestation: any): void {
  const keyPath = process.env.VERIGATE_PUBLIC_KEY_FILE;
  const expectedFingerprint = String(process.env.VERIGATE_PUBLIC_KEY_SHA256 || "").toLowerCase();
  if (!keyPath) fail("VERIGATE_PUBLIC_KEY_FILE is required.");
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) fail("VERIGATE_PUBLIC_KEY_SHA256 must be a pinned SHA-256 fingerprint.");
  if (!attestation || attestation.algorithm !== "Ed25519" || !attestation.payload ||
      typeof attestation.payload !== "object" || Array.isArray(attestation.payload)) {
    fail("Verigate artifact must be an Ed25519 attestation with an object payload.");
  }
  if (typeof attestation.signature !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attestation.signature)) {
    fail("Verigate signature is not canonical base64.");
  }
  const signature = Buffer.from(attestation.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== attestation.signature) {
    fail("Verigate Ed25519 signature must be exactly 64 bytes.");
  }
  const key = crypto.createPublicKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== "ed25519") fail("Pinned Verigate key must be Ed25519.");
  const fingerprint = crypto.createHash("sha256")
    .update(key.export({ type: "spki", format: "der" })).digest("hex");
  if (fingerprint !== expectedFingerprint) fail("Verigate public-key fingerprint mismatch.");
  if (!crypto.verify(null, Buffer.from(canonicalJson(attestation.payload), "utf8"), key, signature)) {
    fail("Verigate signature verification failed.");
  }
}

async function verifyRemotely(attestation: unknown): Promise<void> {
  const base = normalizeBaseUrl(process.env.VERIGATE_BASE_URL || "");
  const response = await fetch(new URL("/v1/verify", base), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(process.env.VERIGATE_API_KEY ? { "x-api-key": process.env.VERIGATE_API_KEY } : {}),
    },
    body: JSON.stringify(attestation),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) fail("Verigate verifier returned HTTP " + response.status + ".");
  const result: any = await response.json();
  if (result?.valid !== true) fail("Verigate verifier did not validate the signed artifact.");
}

export interface VerifiedAuthorization {
  recipient: string;
  amountBaseUnits: string;
  maxFeeBaseUnits: string;
  authorizationId: string;
  intentId: string;
  actionSha256: string;
  expiresAt: number;
  expectedGenesisHash: string;
}

export async function requestAndVerifyAuthorization(action: { to: string; amountPot: string }): Promise<VerifiedAuthorization> {
  if (process.env.VERCEL) fail("Verigate-gated writes are disabled on serverless deployments until a durable atomic authorization store is configured.");
  const endpoint = process.env.VERIGATE_AUTHORIZATION_URL;
  if (!endpoint) fail("VERIGATE_AUTHORIZATION_URL must point to the trusted Verigate authorization adapter.");
  const url = normalizeBaseUrl(endpoint);
  const amountBaseUnits = potToBaseUnits(action.amountPot);
  const configuredFeeCeiling = String(process.env.VERIGATE_MAX_FEE_BASE_UNITS || "");
  if (!/^[1-9][0-9]*$/.test(configuredFeeCeiling)) {
    fail("VERIGATE_MAX_FEE_BASE_UNITS must be configured as a positive base-unit integer before requesting authorization.");
  }
  const requestAction = {
    action_type: "portaldot.substrate_transfer",
    target: action.to,
    amount_exact: amountBaseUnits,
    asset: "POT",
    network: "portaldot-v3-substrate",
    metadata: {
      portaldot_substrate_v3: {
        recipient_ss58: action.to,
        amount_base_units: amountBaseUnits,
        max_fee_base_units: configuredFeeCeiling,
        genesis_hash: PORTALDOT_TESTNET_GENESIS,
      },
    },
  };
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(process.env.VERIGATE_API_KEY ? { "x-api-key": process.env.VERIGATE_API_KEY } : {}),
    },
    body: JSON.stringify({ action: requestAction }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) fail("Verigate authorization adapter returned HTTP " + response.status + ".");
  const artifacts: any = await response.json();
  const receipt = artifacts?.decision_receipt;
  const authorization = artifacts?.execution_authorization;
  if (!receipt?.payload || !authorization?.payload) fail("Verigate response must contain both signed artifacts.");
  verifyLocally(receipt);
  verifyLocally(authorization);
  await verifyRemotely(receipt);
  await verifyRemotely(authorization);

  const rp = receipt.payload;
  const intent = rp.intent;
  const decision = rp.decision;
  const ap = authorization.payload;
  const signedAction = ap.action;
  if (!intent || !decision || !signedAction) fail("Verigate artifacts are missing intent, decision, or action.");
  if (decision.decision !== "ALLOW") fail("Verigate denied this action.");
  if (decision.intent_id !== intent.intent_id || decision.agent_id !== intent.agent_id ||
      ap.intent_id !== intent.intent_id || ap.agent_id !== intent.agent_id || ap.nonce !== intent.intent_id) {
    fail("Verigate receipt and authorization identity bindings do not match.");
  }
  const expectedId = crypto.createHash("sha256").update(String(receipt.signature) + String(ap.nonce)).digest("hex");
  if (String(ap.authorization_id || "").toLowerCase() !== expectedId) fail("Verigate authorization ID mismatch.");
  if (ap.policy_sha256 !== rp.policy_sha256) fail("Verigate policy digest mismatch.");
  if (String(ap.action_sha256 || "").toLowerCase() !== digest(signedAction) ||
      digest(signedAction) !== digest(intent)) fail("Verigate signed action digest mismatch.");
  for (const field of ["intent_id", "agent_id", "action_type", "target", "amount_exact", "asset", "network"]) {
    if ((signedAction[field] ?? null) !== (intent[field] ?? null)) fail("Signed intent mismatch on " + field + ".");
  }
  if (signedAction.action_type !== "portaldot.substrate_transfer" ||
      signedAction.network !== "portaldot-v3-substrate" || signedAction.asset !== "POT") {
    fail("Verigate authorization is not for a native PortalDot V3 Substrate POT transfer.");
  }
  const map = signedAction.metadata?.portaldot_substrate_v3;
  const intentMap = intent.metadata?.portaldot_substrate_v3;
  if (!map || !intentMap) fail("Signed authorization is missing PortalDot Substrate metadata.");
  const recipient = positiveRecipient(map.recipient_ss58);
  if (recipient !== action.to || positiveRecipient(intentMap.recipient_ss58) !== recipient ||
      positiveRecipient(signedAction.target) !== recipient) fail("Requested recipient differs from signed Verigate recipient.");
  if (positiveInteger(signedAction.amount_exact, "signed amount") !== amountBaseUnits ||
      positiveInteger(map.amount_base_units, "signed metadata amount") !== amountBaseUnits ||
      positiveInteger(intentMap.amount_base_units, "intent metadata amount") !== amountBaseUnits) {
    fail("Requested amount differs from signed Verigate amount.");
  }
  const maxFeeBaseUnits = positiveInteger(map.max_fee_base_units, "signed fee ceiling");
  if (maxFeeBaseUnits !== configuredFeeCeiling) fail("Signed fee ceiling differs from the configured PortalPilot fee ceiling.");
  if (positiveInteger(intentMap.max_fee_base_units, "intent fee ceiling") !== maxFeeBaseUnits) {
    fail("Signed fee ceilings do not match.");
  }
  if (String(map.genesis_hash || "").toLowerCase() !== PORTALDOT_TESTNET_GENESIS ||
      String(intentMap.genesis_hash || "").toLowerCase() !== PORTALDOT_TESTNET_GENESIS) {
    fail("Verigate authorization is not bound to the pinned PortalDot V3 testnet genesis.");
  }
  const issuedAt = ap.issued_at;
  const expiresAt = ap.expires_at;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
      issuedAt > now + 15 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    fail("Verigate authorization is expired or has invalid timestamps.");
  }
  return {
    recipient, amountBaseUnits, maxFeeBaseUnits,
    authorizationId: String(ap.authorization_id).toLowerCase(),
    intentId: String(intent.intent_id),
    actionSha256: digest(signedAction),
    expiresAt,
    expectedGenesisHash: PORTALDOT_TESTNET_GENESIS,
  };
}

function positiveRecipient(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("Recipient must be a non-empty SS58 address.");
  return value.trim();
}
