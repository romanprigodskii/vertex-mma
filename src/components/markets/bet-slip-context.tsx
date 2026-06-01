"use client";

import * as React from "react";

import {
  MAX_PARLAY_LEGS,
  type SportsbookSelectionCode,
  isSelectionCode,
} from "@/lib/sportsbook";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One pick in the parlay slip. Self-contained (carries display labels +
 *  an odds snapshot) so the floating slip renders without re-fetching. The
 *  authoritative odds are recomputed server-side at placement. */
export interface SlipLeg {
  boutId: string;
  code: SportsbookSelectionCode;
  odds: number;
  /** "Topuria vs Oliveira" */
  boutLabel: string;
  /** "Topuria", "Topuria by KO/TKO", "Total rounds: Over 2.5", … */
  pickLabel: string;
}

interface BetSlipContextValue {
  legs: SlipLeg[];
  /** Add (or, for the same bout, replace) a pick; clicking the same pick
   *  again toggles it off. One leg per bout. */
  toggleLeg: (leg: SlipLeg) => void;
  removeBout: (boutId: string) => void;
  clear: () => void;
  /** The selection code currently slipped for this bout, or null. */
  codeForBout: (boutId: string) => SportsbookSelectionCode | null;
  hydrated: boolean;
}

const Ctx = React.createContext<BetSlipContextValue | null>(null);
const STORAGE_KEY = "vertex.betslip.v1";

/** Serialise the slip for a shareable "tail my parlay" link (compact keys).
 *  The recipient's slip is populated from this; odds re-price server-side at
 *  placement, so the shared odds are just a display snapshot. */
export function encodeSlip(legs: SlipLeg[]): string {
  return JSON.stringify(
    legs.map((l) => ({
      b: l.boutId,
      c: l.code,
      o: l.odds,
      bl: l.boutLabel,
      pl: l.pickLabel,
    })),
  );
}

/** Parse + sanitise a shared slip param. Returns null on anything malformed. */
export function decodeSlip(raw: string): SlipLeg[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set<string>();
    const legs: SlipLeg[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const boutId = String(item.b ?? "");
      const code = String(item.c ?? "");
      if (!UUID_RE.test(boutId) || !isSelectionCode(code)) continue;
      if (seen.has(boutId)) continue; // one leg per bout
      const odds = Number(item.o);
      if (!Number.isFinite(odds) || odds <= 1) continue;
      seen.add(boutId);
      legs.push({
        boutId,
        code: code as SportsbookSelectionCode,
        odds,
        boutLabel: String(item.bl ?? "").slice(0, 120),
        pickLabel: String(item.pl ?? "").slice(0, 120),
      });
      if (legs.length >= MAX_PARLAY_LEGS) break;
    }
    return legs.length > 0 ? legs : null;
  } catch {
    return null;
  }
}

export function BetSlipProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = React.useState<SlipLeg[]>([]);
  const [hydrated, setHydrated] = React.useState(false);

  // Load once on mount. A shared "?slip=" link (tail-my-parlay) takes
  // precedence over the stored slip; otherwise hydrate from localStorage.
  // Both are client-only (no SSR), the canonical effect-setState exception.
  React.useEffect(() => {
    let loaded: SlipLeg[] | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const shared = params.get("slip");
      if (shared) {
        loaded = decodeSlip(shared);
        // Strip the param so a refresh doesn't re-import the shared slip.
        params.delete("slip");
        const qs = params.toString();
        window.history.replaceState(
          {},
          "",
          window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
        );
      }
      if (!loaded) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) loaded = parsed as SlipLeg[];
        }
      }
    } catch {
      // ignore malformed storage / url
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only hydration
    if (loaded) setLegs(loaded);
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legs));
    } catch {
      // ignore quota / private-mode errors
    }
  }, [legs, hydrated]);

  const toggleLeg = React.useCallback((leg: SlipLeg) => {
    setLegs((prev) => {
      const existing = prev.find((l) => l.boutId === leg.boutId);
      // Same bout + same pick → toggle off.
      if (existing && existing.code === leg.code) {
        return prev.filter((l) => l.boutId !== leg.boutId);
      }
      // One leg per bout: drop any other pick on this bout first.
      const without = prev.filter((l) => l.boutId !== leg.boutId);
      // Cap only blocks adding a NEW bout beyond the limit (replacing is fine).
      if (!existing && without.length >= MAX_PARLAY_LEGS) return prev;
      return [...without, leg];
    });
  }, []);

  const removeBout = React.useCallback(
    (boutId: string) => setLegs((prev) => prev.filter((l) => l.boutId !== boutId)),
    [],
  );
  const clear = React.useCallback(() => setLegs([]), []);
  const codeForBout = React.useCallback(
    (boutId: string) => legs.find((l) => l.boutId === boutId)?.code ?? null,
    [legs],
  );

  const value = React.useMemo(
    () => ({ legs, toggleLeg, removeBout, clear, codeForBout, hydrated }),
    [legs, toggleLeg, removeBout, clear, codeForBout, hydrated],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBetSlip(): BetSlipContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useBetSlip must be used within a BetSlipProvider");
  return ctx;
}
