/**
 * Node-side defensive DNS fallback — mirrors `scripts/photo_scraper/src/dns_override.py`.
 *
 * The host machine's primary DNS sometimes times out (logged extensively in
 * Wave 2.5 and again in 3B.1.2). When that happens, `dns.lookup` — which
 * Node's `net`/`http` stacks use to resolve hostnames before connecting —
 * fails, taking down postgres-js connections to the Supabase pooler and any
 * font fetches.
 *
 * This module monkey-patches `dns.lookup` to:
 *   1. Try the system resolver first (fast path; no-op on healthy hosts).
 *   2. On EAI_AGAIN / ENOTFOUND / ETIMEOUT, fall through to a `dns.Resolver`
 *      pinned to Cloudflare / Quad9 nameservers and resolve A records via
 *      c-ares (which bypasses the system resolver entirely).
 *
 * Import this module BEFORE anything that opens a socket. The drizzle client
 * imports it at module top so the patch is in place by the time any query
 * runs.
 */

import dns, { type LookupAddress, type LookupOptions, Resolver } from "node:dns";

const FALLBACK_NS: readonly string[] = ["1.1.1.1", "9.9.9.9", "8.8.4.4"];

let installed = false;

function shouldFallback(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === "EAI_AGAIN" ||
    err.code === "ENOTFOUND" ||
    err.code === "ETIMEOUT" ||
    err.code === "ESERVFAIL"
  );
}

export function install(): void {
  if (installed) return;
  installed = true;

  const fallback = new Resolver();
  fallback.setServers([...FALLBACK_NS]);
  const fallbackLookup = (host: string): Promise<string> =>
    new Promise((resolve, reject) => {
      fallback.resolve4(host, (err, addrs) => {
        if (err || !addrs.length) reject(err ?? new Error("no records"));
        else resolve(addrs[0]);
      });
    });

  const originalLookup = dns.lookup;

  function patched(
    host: string,
    optionsOrCb: number | LookupOptions | ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void),
    cb?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void {
    type Cb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
    let options: LookupOptions = {};
    let callback: Cb;
    if (typeof optionsOrCb === "function") {
      callback = optionsOrCb as Cb;
    } else {
      options =
        typeof optionsOrCb === "number"
          ? { family: optionsOrCb }
          : optionsOrCb;
      callback = cb as Cb;
    }

    // Use the original lookup first. Only fall through if it fails with a
    // transport-style error AND we got a hostname (numeric IPs short-circuit
    // before us anyway).
    (originalLookup as (h: string, o: LookupOptions, c: Cb) => void)(
      host,
      options,
      (err, address, family) => {
        if (!err) {
          callback(null, address, family);
          return;
        }
        if (!shouldFallback(err)) {
          callback(err, address, family);
          return;
        }
        // Skip numeric / loopback / empty.
        if (!host || /^[\d.]+$/.test(host) || host === "localhost") {
          callback(err, address, family);
          return;
        }
        fallbackLookup(host).then(
          (ip) => callback(null, ip, 4),
          () => callback(err, address, family),
        );
      },
    );
  }

  // Drop-in replacement keeping the original symbol intact for anything that
  // captured it before install (vanishingly rare in app code).
  (dns as unknown as { lookup: typeof patched }).lookup = patched;
}
