import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  consumeExecutionAuthorization,
  requestAndVerifyAuthorization,
} from "../src/verigate.ts";
import {
  assertPortalDotTestnetGenesis,
  PORTALDOT_TESTNET_GENESIS,
} from "../src/sdk/tx.ts";

const recipient = "5GrwvaEF5zXb26Fz9rcQpDWS7Q7f6B8e4pK5s7c8f9gH2j3k";
const policyHash = "a".repeat(64);

function sign(payload: unknown, key: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonicalJson(payload), "utf8"), key).toString("base64");
}

async function withMockVerigate(
  mode: "allow" | "deny" | "mutate-action",
  run: () => Promise<void>,
  consumeAllowed = true,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portalpilot-verigate-test-"));
  const issuer = crypto.generateKeyPairSync("ed25519");
  const agent = crypto.generateKeyPairSync("ed25519");
  const issuerPrivatePath = path.join(dir, "issuer-private.pem");
  const issuerPublicPath = path.join(dir, "issuer-public.pem");
  const agentPrivatePath = path.join(dir, "agent-private.pem");
  fs.writeFileSync(issuerPrivatePath, issuer.privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(issuerPublicPath, issuer.publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(agentPrivatePath, agent.privateKey.export({ type: "pkcs8", format: "pem" }));

  const issuerFingerprint = crypto.createHash("sha256")
    .update(issuer.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const agentDer = agent.publicKey.export({ type: "spki", format: "der" });
  const identityId = crypto.createHash("sha256").update(agentDer.subarray(agentDer.length - 32)).digest("hex");

  const oldEnv: Record<string, string | undefined> = {};
  const env = {
    VERIGATE_BASE_URL: "http://127.0.0.1:19876",
    VERIGATE_IDENTITY_ID: identityId,
    VERIGATE_CAPABILITY_ID: "cap-test-transfer",
    VERIGATE_AGENT_ID: "agent-test",
    VERIGATE_AGENT_PRIVATE_KEY_FILE: agentPrivatePath,
    VERIGATE_PUBLIC_KEY_FILE: issuerPublicPath,
    VERIGATE_PUBLIC_KEY_SHA256: issuerFingerprint,
    VERIGATE_MAX_FEE_BASE_UNITS: "5000000000",
    VERCEL: undefined,
    VERIGATE_SINGLE_PROCESS_MODE: "true",
  };
  for (const [key, value] of Object.entries(env)) {
    oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/verify")) return new Response(JSON.stringify({ valid: true, reason: "test verifier" }), { status: 200 });
    if (url.endsWith("/v1/execution/consume")) return new Response(JSON.stringify({
      execute: consumeAllowed,
      reason: consumeAllowed ? "execution authorization consumed" : "execution authorization already consumed",
    }), { status: 200 });
    if (!url.endsWith("/v1/actions/authorize")) return new Response("not found", { status: 404 });
    const request = JSON.parse(String(init?.body));
    assert.equal(request.amount_exact, "0.25", "Verigate policy amount must be expressed in human POT units");
    assert.equal(request.metadata?.portaldot_substrate_v3?.amount_base_units, "25000000000000");
    const amount = request.amount_exact;
    const intent = {
      intent_id: request.intent_id,
      agent_id: request.agent_id,
      action_type: request.action_type,
      target: request.target,
      resource: request.resource,
      amount,
      amount_exact: amount,
      asset: request.asset,
      network: request.network,
      purpose: request.purpose,
      declared_context: request.declared_context,
      input_provenance: {},
      parent_intent_id: request.parent_intent_id,
      requested_capability: request.requested_capability,
      constraints: request.constraints,
      metadata: request.metadata,
      timestamp: request.timestamp,
    };
    const decision = {
      intent_id: intent.intent_id,
      agent_id: intent.agent_id,
      decision: mode === "deny" ? "BLOCK" : "ALLOW",
      context_sha256: "b".repeat(64),
      matched_rules: [],
      evaluated_at: Math.floor(Date.now() / 1000),
    };
    const receiptPayload = {
      receipt_version: 1,
      intent,
      decision,
      policy_sha256: policyHash,
      signed_policy_version: null,
    };
    const receipt = {
      payload: receiptPayload,
      signature: sign(receiptPayload, issuer.privateKey),
      algorithm: "Ed25519",
    };
    if (mode === "deny") {
      return new Response(JSON.stringify({ decision_receipt: receipt, execution_authorization: null }), { status: 200 });
    }
    const authorizedAction = JSON.parse(JSON.stringify(intent));
    if (mode === "mutate-action") authorizedAction.target = "5DifferentRecipient";
    const now = Math.floor(Date.now() / 1000);
    const authorizationPayload = {
      authorization_version: 1,
      authorization_id: crypto.createHash("sha256").update(receipt.signature + intent.intent_id).digest("hex"),
      decision_receipt_sha256: "c".repeat(64),
      intent_id: intent.intent_id,
      agent_id: intent.agent_id,
      policy_sha256: policyHash,
      capability_id: request.capability_id,
      identity_id: request.identity_id,
      action: authorizedAction,
      action_sha256: crypto.createHash("sha256").update(canonicalJson(authorizedAction)).digest("hex"),
      nonce: intent.intent_id,
      issued_at: now,
      expires_at: now + 120,
    };
    const authorization = {
      payload: authorizationPayload,
      signature: sign(authorizationPayload, issuer.privateKey),
      algorithm: "Ed25519",
    };
    return new Response(JSON.stringify({ decision_receipt: receipt, execution_authorization: authorization }), { status: 200 });
  };

  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts a signed Verigate ALLOW bound to the exact recipient and amount", async () => {
  await withMockVerigate("allow", async () => {
    const result = await requestAndVerifyAuthorization({ to: recipient, amountPot: "0.25" });
    assert.equal(result.recipient, recipient);
    assert.equal(result.amountBaseUnits, "25000000000000");
    assert.equal(result.maxFeeBaseUnits, "5000000000");
    assert.ok(result.expiresAt > Math.floor(Date.now() / 1000));
    await consumeExecutionAuthorization(result.executionAuthorization);
  });
});

test("fails closed when Verigate refuses one-time execution consumption", async () => {
  await withMockVerigate("allow", async () => {
    const result = await requestAndVerifyAuthorization({ to: recipient, amountPot: "0.25" });
    await assert.rejects(
      consumeExecutionAuthorization(result.executionAuthorization),
      /Verigate refused one-time execution consumption: execution authorization already consumed/,
    );
  }, false);
});

test("fails closed when Verigate returns BLOCK", async () => {
  await withMockVerigate("deny", async () => {
    await assert.rejects(
      requestAndVerifyAuthorization({ to: recipient, amountPot: "0.25" }),
      /Verigate denied this action: BLOCK/,
    );
  });
});

test("fails closed when signed execution action differs from the decision receipt", async () => {
  await withMockVerigate("mutate-action", async () => {
    await assert.rejects(
      requestAndVerifyAuthorization({ to: recipient, amountPot: "0.25" }),
      /signed action digest mismatch/,
    );
  });
});


test("pinned PortalDot genesis check accepts only the expected testnet", () => {
  const api = (genesis: string) => ({
    genesisHash: { toHex: () => genesis },
  }) as any;

  assert.doesNotThrow(() => assertPortalDotTestnetGenesis(api(PORTALDOT_TESTNET_GENESIS)));
  assert.throws(
    () => assertPortalDotTestnetGenesis(api("0x" + "ab".repeat(32))),
    /PortalDot testnet genesis mismatch/,
  );
});
