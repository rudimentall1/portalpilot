# PortalPilot + Verigate integration status

## What this branch gates

- `POST /api/ask`: write intents are limited to one native POT transfer. The route obtains and locally verifies Verigate's signed decision receipt and execution authorization, verifies both with the configured Verigate verifier, binds recipient, amount, network, genesis, and fee ceiling, and compares the unsigned SCALE call before calling `planAction()` (which signs the extrinsic).
- `POST /api/execute`: consumes the in-process one-time authorization before asynchronous work, checks expiry, then submits only the cached extrinsic whose method bytes match the authorized call. Expiry is checked again immediately before submission.
- Batch transfers, remarks, ink! contract deployment/writes, non-testnet writes, missing configuration, invalid signatures, verifier failures, changed call bytes, expired authorizations, and fee estimates above the signed ceiling fail closed.

## Important deployment limits

This is a local single-process integration spike, not production-ready authorization infrastructure.

- The authorization map is process-local. The gate explicitly refuses writes when `VERCEL` is set. Multi-instance deployments need a durable shared store with atomic `putIfAbsent` and `take` semantics before writes can be enabled.
- Authorization is requested from Verigate's existing `POST /v1/actions/authorize` endpoint. Configure an active registered `VERIGATE_AGENT_ID`, `VERIGATE_IDENTITY_ID`, and `VERIGATE_CAPABILITY_ID`; the agent private key must match the registered identity and is used server-side to sign the exact ActionIntent.
- Configure `VERIGATE_PUBLIC_KEY_FILE` and independently pin its SPKI DER SHA-256 in `VERIGATE_PUBLIC_KEY_SHA256`. The remote `/v1/verify` check is additional validation, not a substitute for local signature verification.
- `VERIGATE_MAX_FEE_BASE_UNITS` must be a positive integer in POT base units (14 decimals), and the same exact value must be present in the signed intent and authorization. This is a preflight ceiling against the node's estimate, not an on-chain guarantee of the final fee charged.
- `VERIGATE_AGENT_PRIVATE_KEY_FILE` is the agent identity key used to sign the intent; `VERIGATE_PUBLIC_KEY_FILE` is the Verigate issuer key used to verify returned artifacts. `PORTALDOT_SIGNER_SEED` is PortalPilot's Substrate transaction signer. Gated writes reject a missing seed and well-known `//Alice`-style development URIs. These are three distinct keys and all remain server-side. Never expose them to the browser.
- The endpoint and genesis hash are pinned to the recorded PortalDot V3 Substrate testnet. No mainnet write path is enabled by this gate.

## Verification still required

GitHub Actions runs `npx tsc --noEmit`, the `test:verigate` suite (canonicalization, signed ALLOW/BLOCK and tamper cases, plus route-level regressions for contract-write bypass), and the frontend production build. Those checks do not establish live authorization or transaction behavior. Before treating this as end-to-end integrated, configure the server-side keys and Verigate identity/capability, then run locally:

```sh
npm install
npx tsc --noEmit
npm run test:verigate
npm run server
```

Then test a valid allowlisted transfer, a denied recipient, amount above policy, expiry, altered SCALE call bytes, fee ceiling violation, and concurrent/replayed `/api/execute` requests. Do not claim a live testnet transfer or denial until the transaction and denial evidence are captured independently.
