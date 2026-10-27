# PortalPilot + Verigate integration status

## What this branch gates

- `POST /api/ask`: write intents are limited to one native POT transfer. The route obtains and locally verifies Verigate's signed decision receipt and execution authorization, verifies both with the configured Verigate verifier, binds recipient, amount, network, genesis, and fee ceiling, and compares the unsigned SCALE call before calling `planAction()` (which signs the extrinsic).
- `POST /api/execute`: consumes the in-process one-time authorization before asynchronous work, checks expiry, then submits only the cached extrinsic whose method bytes match the authorized call. Expiry is checked again immediately before submission.
- Batch transfers, remarks, non-testnet writes, missing configuration, invalid signatures, verifier failures, changed call bytes, expired authorizations, and fee estimates above the signed ceiling fail closed.

## Important deployment limits

This is a local single-process integration spike, not production-ready authorization infrastructure.

- The authorization map is process-local. The gate explicitly refuses writes when `VERCEL` is set. Multi-instance deployments need a durable shared store with atomic `putIfAbsent` and `take` semantics before writes can be enabled.
- `VERIGATE_AUTHORIZATION_URL` is an operator-provided trusted adapter endpoint. It must create the intent through the supported Verigate workflow and return both signed artifacts as `{ "decision_receipt": ..., "execution_authorization": ... }`. This repository does not claim that a built-in endpoint with this contract already exists.
- Configure `VERIGATE_PUBLIC_KEY_FILE` and independently pin its SPKI DER SHA-256 in `VERIGATE_PUBLIC_KEY_SHA256`. The remote `/v1/verify` check is additional validation, not a substitute for local signature verification.
- `VERIGATE_MAX_FEE_BASE_UNITS` must be a positive integer in POT base units (14 decimals), and the same exact value must be present in the signed intent and authorization.
- `PORTALDOT_SIGNER_SEED` is the PortalPilot Substrate transaction signer. It is distinct from Verigate's Ed25519 issuer key and must remain server-side. Never expose either private key to the browser.
- The endpoint and genesis hash are pinned to the recorded PortalDot V3 Substrate testnet. No mainnet write path is enabled by this gate.

## Verification still required

The GitHub API connector used to author this branch does not run the repository's TypeScript compiler or execute its tests. Before treating this as integrated, run locally:

```sh
npm install
npx tsc --noEmit
npm run server
```

Then test a valid allowlisted transfer, a denied recipient, amount above policy, expiry, altered SCALE call bytes, fee ceiling violation, and concurrent/replayed `/api/execute` requests. Do not claim a live testnet transfer or denial until the transaction and denial evidence are captured independently.
