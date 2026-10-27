const post = (body: any) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function unwrap(r: Response) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error || r.statusText);
  return data;
}

export const api = {
  ask: (text: string, network: string) => fetch("/api/ask", post({ text, network })).then(unwrap),
  execute: (planId: string) => fetch("/api/execute", post({ planId })).then(unwrap),
  cancel: (planId: string) => fetch("/api/cancel", post({ planId })).then(unwrap),
  chain: (network: string) => fetch(`/api/chain?network=${network}`).then(unwrap),
  blocks: (network: string, count = 8) => fetch(`/api/blocks?network=${network}&count=${count}`).then(unwrap),
  health: () => fetch("/api/health").then(unwrap),
};
