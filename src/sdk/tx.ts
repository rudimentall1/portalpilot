import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { getApi, getApiWithTimeout, chainMeta } from "./portaldot";
import { getSigner } from "./signer";
import { potToPlanck, formatPot, shortAddr } from "./format";
import { isValidAddress } from "./accounts";

export type WriteAction =
  | { kind: "transfer"; to: string; amountPot: string }
  | { kind: "batchTransfer"; transfers: { to: string; amountPot: string }[] }
  | { kind: "remark"; message: string };

export interface DryRunResult {
  ran: boolean;
  ok: boolean;
  detail: string;
}

export interface Plan {
  id: string;
  network: string;
  summary: string;
  signer: string;
  action: WriteAction;
  callHex: string;
  feePlanck: string;
  feeDisplay: string;
  weight: string;
  dryRun: DryRunResult;
  warnings: string[];
  createdAt: number;
}

export interface Receipt {
  ok: boolean;
  error?: string;
  blockHash: string;
  txHash: string;
  events: string[];
  finalizedAt: number;
}

const planCache = new Map<string, { tx: SubmittableExtrinsic<"promise">; network: string }>();

export function formatDispatchError(api: ApiPromise, dispatchError: any): string {
  try {
    if (dispatchError?.isModule) {
      const decoded = api.registry.findMetaError(dispatchError.asModule);
      return `${decoded.section}.${decoded.name} — ${decoded.docs.join(" ").trim() || "module error"}`;
    }
    if (dispatchError?.toString) return dispatchError.toString();
  } catch {
    /* ignore */
  }
  return "unknown dispatch error";
}

// Turn a TransactionValidityError (from system.dryRun) into a human sentence.
export function formatValidityError(err: any): string {
  try {
    if (err?.isInvalid) {
      const t = String(err.asInvalid.type);
      const map: Record<string, string> = {
        Payment: "Insufficient balance to pay the transaction fee.",
        Stale: "Transaction nonce is too low (stale).",
        Future: "Transaction nonce is too high (future).",
        BadProof: "Invalid signature / proof.",
        BadSigner: "Invalid signer for this call.",
        ExhaustsResources: "Transaction would exhaust block resources.",
        Call: "This call is not permitted.",
        AncientBirthBlock: "Transaction birth block is too old.",
        BadMandatory: "A mandatory dispatch would fail.",
        MandatoryValidation: "A mandatory dispatch failed validation.",
      };
      return map[t] || `Node would reject it (${t}).`;
    }
    if (err?.isUnknown) return `Node can't validate it (${String(err.asUnknown.type)}).`;
    if (err?.toHuman) return JSON.stringify(err.toHuman());
  } catch {
    /* ignore */
  }
  return "The node would reject this transaction.";
}

export async function buildActionTx(
  api: ApiPromise,
  action: WriteAction
): Promise<{ tx: SubmittableExtrinsic<"promise">; summary: string; warnings: string[] }> {
  const { decimals, symbol, ss58 } = chainMeta(api);
  const warnings: string[] = [];
  switch (action.kind) {
    case "transfer": {
      const v = isValidAddress(action.to, ss58);
      if (!v.valid) throw new Error(`Invalid recipient address: ${v.error}`);
      const planck = potToPlanck(action.amountPot, decimals);
      if (planck <= 0n) throw new Error("Amount must be greater than zero.");
      const tx = api.tx.balances.transferKeepAlive(v.normalized!, planck);
      return { tx, summary: `Transfer ${action.amountPot} ${symbol} → ${shortAddr(v.normalized!)}`, warnings };
    }
    case "batchTransfer": {
      if (!action.transfers.length) throw new Error("No transfers specified.");
      const calls = action.transfers.map((t) => {
        const v = isValidAddress(t.to, ss58);
        if (!v.valid) throw new Error(`Invalid address ${t.to}: ${v.error}`);
        return api.tx.balances.transferKeepAlive(v.normalized!, potToPlanck(t.amountPot, decimals));
      });
      const tx = api.tx.utility.batchAll(calls);
      const total = action.transfers.reduce((s, t) => s + Number(t.amountPot || 0), 0);
      return { tx, summary: `Batch: ${action.transfers.length} transfers totalling ~${total} ${symbol}`, warnings };
    }
    case "remark": {
      const msg = (action.message || "").slice(0, 256);
      if (!msg) throw new Error("Empty remark message.");
      const tx = api.tx.system.remarkWithEvent(msg);
      return { tx, summary: `Post on-chain remark: "${msg}"`, warnings };
    }
    default:
      throw new Error("Unsupported action.");
  }
}

async function dryRunSigned(api: ApiPromise, tx: SubmittableExtrinsic<"promise">): Promise<DryRunResult> {
  try {
    const res: any = await api.rpc.system.dryRun(tx.toHex());
    if (res.isOk) {
      const inner = res.asOk;
      if (inner.isOk) {
        return { ran: true, ok: true, detail: "Simulation succeeded — the extrinsic would apply cleanly on-chain." };
      }
      return { ran: true, ok: false, detail: `Would fail: ${formatDispatchError(api, inner.asErr)}` };
    }
    return { ran: true, ok: false, detail: formatValidityError(res.asErr) };
  } catch {
    return { ran: false, ok: true, detail: "Dry-run RPC unavailable here; fee + structure validated instead." };
  }
}

export async function planAction(action: WriteAction, network?: string): Promise<Plan> {
  const api = await getApiWithTimeout(network);
  const meta = chainMeta(api);
  const signer = await getSigner(meta.ss58);
  const { tx, summary, warnings } = await buildActionTx(api, action);

  // Fee preview (payment_queryInfo)
  let feePlanck = 0n;
  let weight = "n/a";
  try {
    const info = await tx.paymentInfo(signer.address);
    feePlanck = info.partialFee.toBigInt();
    weight = info.weight.toString();
  } catch (e: any) {
    warnings.push(`Fee estimate unavailable: ${e?.message || e}`);
  }

  // Balance sanity check for value transfers
  try {
    if (action.kind === "transfer" || action.kind === "batchTransfer") {
      const acc: any = await api.query.system.account(signer.address);
      if (acc.data.free.toBigInt() === 0n) {
        warnings.push(
          process.env.VERCEL
            ? "The demo signer has 0 POT on mainnet, so the on-chain dry-run safely blocks this write — the safety pipeline is doing its job. To execute a real POT-gas transfer, run PortalPilot locally with the dev node (Alice is funded); see the README."
            : "Signer has 0 POT on this network — execution will fail. Switch to the Local Dev Node (Alice is funded) or fund the account."
        );
      }
    }
  } catch {
    /* ignore */
  }

  // Sign in place, then dry-run the EXACT signed extrinsic we will submit
  await tx.signAsync(signer);
  const dryRun = await dryRunSigned(api, tx);

  const id = tx.hash.toHex();
  planCache.set(id, { tx, network: network ?? "default" });

  return {
    id,
    network: network ?? "default",
    summary,
    signer: signer.address,
    action,
    callHex: tx.method.toHex(),
    feePlanck: feePlanck.toString(),
    feeDisplay: formatPot(feePlanck, meta.decimals, meta.symbol),
    weight,
    dryRun,
    warnings,
    createdAt: Date.now(),
  };
}

// Verigate integration boundary: only the pinned PortalDot V3 Substrate testnet is accepted.
export const PORTALDOT_TESTNET_RPC = "wss://test-node-v3.portaldot.dev";
export const PORTALDOT_TESTNET_GENESIS =
  "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";

/** Refuse a PortalDot testnet operation if the connected endpoint is another chain. */
export function assertPortalDotTestnetGenesis(api: Pick<ApiPromise, "genesisHash">): void {
  const actualGenesis = api.genesisHash.toHex().toLowerCase();
  if (actualGenesis !== PORTALDOT_TESTNET_GENESIS) {
    throw new Error(`PortalDot testnet genesis mismatch: expected ${PORTALDOT_TESTNET_GENESIS}, got ${actualGenesis}.`);
  }
}

/**
 * Encode a single native transfer without signing or submitting it.
 * Amount is exact base units; floating-point values and non-canonical strings are rejected.
 */
export async function encodeUnsignedTransferCallHex(
  recipient: string,
  amountBaseUnits: string | bigint,
  network: string = PORTALDOT_TESTNET_RPC
): Promise<string> {
  if (network !== PORTALDOT_TESTNET_RPC) {
    throw new Error("Verigate-gated transfers are restricted to the pinned PortalDot V3 Substrate testnet.");
  }
  const amountText = typeof amountBaseUnits === "bigint" ? amountBaseUnits.toString() : amountBaseUnits;
  if (typeof amountText !== "string" || !/^[1-9][0-9]*$/.test(amountText)) {
    throw new Error("Transfer amount must be a positive canonical base-unit integer.");
  }
  const amount = BigInt(amountText);
  const api = await getApiWithTimeout(PORTALDOT_TESTNET_RPC);
  assertPortalDotTestnetGenesis(api);
  const meta = chainMeta(api);
  const validation = isValidAddress(recipient, meta.ss58);
  if (!validation.valid || !validation.normalized) {
    throw new Error(`Invalid transfer recipient: ${validation.error || "address could not be normalized"}`);
  }
  return api.tx.balances.transferKeepAlive(validation.normalized, amount).method.toHex();
}

/**
 * Guarded submission primitive. The same cached extrinsic object whose call bytes
 * are checked is submitted; the cache entry is consumed before send to prevent
 * concurrent replay within this process. Route-level Verigate authorization and
 * atomic shared storage are still required.
 */
export async function executeAuthorizedPlan(
  id: string,
  expectedCallHex: string,
  expiresAt?: number
): Promise<Receipt> {
  if (typeof expectedCallHex !== "string" || !/^0x[0-9a-f]+$/i.test(expectedCallHex)) {
    throw new Error("A canonical expected SCALE call is required.");
  }
  const cached = planCache.get(id);
  if (!cached) throw new Error("Plan expired or not found. Please re-issue the command.");
  const api = await getApi(cached.network === "default" ? undefined : cached.network);
  if (cached.network === PORTALDOT_TESTNET_RPC) assertPortalDotTestnetGenesis(api);
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) {
    throw new Error("Verigate authorization expired immediately before submission; refusing execution.");
  }
  const current = planCache.get(id);
  if (!current || current.tx !== cached.tx) {
    throw new Error("Plan changed while authorization was being checked; refusing execution.");
  }
  const actualCallHex = cached.tx.method.toHex();
  if (actualCallHex.toLowerCase() !== expectedCallHex.toLowerCase()) {
    throw new Error("Cached extrinsic call differs from Verigate authorization; refusing execution.");
  }
  // No await between this deletion and submission: concurrent calls cannot reuse the plan.
  planCache.delete(id);
  return new Promise<Receipt>((resolve, reject) => {
    cached.tx
      .send((result: any) => {
        const { status, dispatchError, events, txHash } = result;
        if (status.isInBlock || status.isFinalized) {
          const bh = status.isInBlock ? status.asInBlock : status.asFinalized;
          if (dispatchError) {
            resolve({
              ok: false,
              error: formatDispatchError(api, dispatchError),
              blockHash: bh.toHex(),
              txHash: txHash.toHex(),
              events: [],
              finalizedAt: Date.now(),
            });
          } else {
            resolve({
              ok: true,
              blockHash: bh.toHex(),
              txHash: txHash.toHex(),
              events: (events || []).map((e: any) => `${e.event.section}.${e.event.method}`),
              finalizedAt: Date.now(),
            });
          }
        }
      })
      .catch(reject);
  });
}

export async function executePlan(id: string): Promise<Receipt> {
  // Defense in depth: never allow callers to bypass the route-level Verigate gate
  // when the integration is enabled, or from a serverless deployment.
  if (process.env.VERCEL || process.env.VERIGATE_SINGLE_PROCESS_MODE === "true") {
    throw new Error("Unguarded executePlan is disabled in Verigate or serverless mode; use executeAuthorizedPlan.");
  }
  const cached = planCache.get(id);
  if (!cached) throw new Error("Plan expired or not found. Please re-issue the command.");
  const api = await getApi(cached.network === "default" ? undefined : cached.network);
  return new Promise<Receipt>((resolve, reject) => {
    cached.tx
      .send((result: any) => {
        const { status, dispatchError, events, txHash } = result;
        if (status.isInBlock || status.isFinalized) {
          const bh = status.isInBlock ? status.asInBlock : status.asFinalized;
          planCache.delete(id);
          if (dispatchError) {
            resolve({
              ok: false,
              error: formatDispatchError(api, dispatchError),
              blockHash: bh.toHex(),
              txHash: txHash.toHex(),
              events: [],
              finalizedAt: Date.now(),
            });
          } else {
            resolve({
              ok: true,
              blockHash: bh.toHex(),
              txHash: txHash.toHex(),
              events: (events || []).map((e: any) => `${e.event.section}.${e.event.method}`),
              finalizedAt: Date.now(),
            });
          }
        }
      })
      .catch(reject);
  });
}

// Read-only fee estimate (does not sign, so it consumes no nonce).
export async function estimateFee(action: WriteAction, network?: string) {
  const api = await getApiWithTimeout(network);
  const meta = chainMeta(api);
  const signer = await getSigner(meta.ss58);
  const { tx, summary } = await buildActionTx(api, action);
  const info = await tx.paymentInfo(signer.address);
  const fee = info.partialFee.toBigInt();
  return {
    summary,
    feePlanck: fee.toString(),
    feeDisplay: formatPot(fee, meta.decimals, meta.symbol),
    weight: info.weight.toString(),
  };
}

export function discardPlan(id: string): boolean {
  return planCache.delete(id);
}

export function planCount(): number {
  return planCache.size;
}
