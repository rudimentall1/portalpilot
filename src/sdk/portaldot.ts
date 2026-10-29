import { ApiPromise, WsProvider } from "@polkadot/api";

export interface ChainInfo {
  network: string;
  endpoint: string;
  chain: string;
  nodeName: string;
  nodeVersion: string;
  ss58: number;
  decimals: number;
  symbol: string;
  specName: string;
  specVersion: number;
  blockNumber: number;
  peers?: number;
  isSyncing?: boolean;
  palletCount: number;
  callCount: number;
}

export const NETWORKS = {
  mainnet: { label: "Portaldot Mainnet", endpoint: process.env.PORTALDOT_WS_MAINNET || "wss://mainnet.portaldot.io" },
  testnet: { label: "PortalDot V3 Testnet (Verigate-gated writes)", endpoint: "wss://test-node-v3.portaldot.dev" },
  // Local defaults to a node on this machine. On a hosted deploy you can point
  // it at a public wss tunnel to your funded dev node via PORTALDOT_LOCAL_WS,
  // which makes the hosted "Local" network execute real POT-gas writes.
  local: { label: "Local Dev Node", endpoint: process.env.PORTALDOT_LOCAL_WS || "ws://127.0.0.1:9944" },
} as const;
export type NetworkId = keyof typeof NETWORKS;

const apis = new Map<string, Promise<ApiPromise>>();

export function resolveEndpoint(network?: string): string {
  if (!network) return process.env.PORTALDOT_WS || NETWORKS.mainnet.endpoint;
  if (network in NETWORKS) return NETWORKS[network as NetworkId].endpoint;
  return network; // allow a raw ws(s):// url
}

export async function getApi(network?: string): Promise<ApiPromise> {
  const endpoint = resolveEndpoint(network);
  // On a hosted/serverless deploy a localhost node is unreachable. Fail fast
  // instead of spawning an auto-reconnecting WsProvider that spams "Abnormal
  // Closure" errors and 502s in the logs.
  if (process.env.VERCEL && /127\.0\.0\.1|localhost/.test(endpoint)) {
    throw new Error(
      "The Local network needs a node on your machine and isn't reachable from the hosted demo — switch to Mainnet, or run PortalPilot locally."
    );
  }
  if (!apis.has(endpoint)) {
    const provider = new WsProvider(endpoint, 2500); // auto-reconnect every 2.5s
    apis.set(
      endpoint,
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: false })
    );
  }
  return apis.get(endpoint)!;
}

// Connect with a timeout so an unreachable endpoint (e.g. a local node that isn't running) fails fast.
export async function getApiWithTimeout(network?: string, ms = 6000): Promise<ApiPromise> {
  const endpoint = resolveEndpoint(network);
  const apiP = getApi(network);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out connecting to ${endpoint}`)), ms)
  );
  const api = (await Promise.race([apiP, timeout])) as ApiPromise;
  await Promise.race([api.isReady, timeout]);
  return api;
}

export function countCalls(api: ApiPromise): { pallets: number; calls: number } {
  const sections = Object.keys(api.tx);
  let calls = 0;
  for (const s of sections) calls += Object.keys((api.tx as any)[s]).length;
  return { pallets: sections.length, calls };
}

export async function getChainInfo(network?: string): Promise<ChainInfo> {
  const api = await getApiWithTimeout(network);
  const [chain, nodeName, nodeVersion, header, health] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.name(),
    api.rpc.system.version(),
    api.rpc.chain.getHeader(),
    api.rpc.system.health().catch(() => null),
  ]);
  const rv = api.runtimeVersion;
  const { pallets, calls } = countCalls(api);
  return {
    network: network ?? "default",
    endpoint: resolveEndpoint(network),
    chain: chain.toString(),
    nodeName: nodeName.toString(),
    nodeVersion: nodeVersion.toString(),
    ss58: api.registry.chainSS58 ?? POT.ss58,
    decimals: POT.decimals,
    symbol: POT.symbol,
    specName: rv.specName.toString(),
    specVersion: rv.specVersion.toNumber(),
    blockNumber: header.number.toNumber(),
    peers: health ? Number(health.peers.toString()) : undefined,
    isSyncing: health ? health.isSyncing.isTrue : undefined,
    palletCount: pallets,
    callCount: calls,
  };
}

// Portaldot's token constants are authoritative. The local --dev node does NOT advertise
// system.properties (decimals/symbol/ss58), so trusting @polkadot/api's registry defaults
// would yield wrong values (12 dp / "Unit") and make every amount & fee off by 100x.
export const POT = { decimals: 14, symbol: "POT", ss58: 42 } as const;

export function chainMeta(_api: ApiPromise) {
  return { ss58: POT.ss58, decimals: POT.decimals, symbol: POT.symbol };
}

export async function disconnectAll(): Promise<void> {
  for (const p of apis.values()) {
    try {
      const api = await p;
      await api.disconnect();
    } catch {
      /* ignore */
    }
  }
  apis.clear();
}
