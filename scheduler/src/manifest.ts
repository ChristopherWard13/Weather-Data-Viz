/**
 * A product's latest run id from its manifest, or null if it has no manifest
 * (or no runs) yet. Only the "latest" key is read: parsing every manifest in
 * full each tick costs CPU time the Workers free plan rations.
 */
export async function latestRun(base: string, product: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchFn(`${base}${product}/manifest.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const m = (await res.text()).match(/"latest":\s*(?:"(\d{10})"|null)/);
  if (!m) throw new Error("manifest has no latest run");
  return m[1] ?? null;
}
