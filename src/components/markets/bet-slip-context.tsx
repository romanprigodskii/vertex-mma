"use client";

import * as React from "react";

import { MAX_PARLAY_LEGS, type SportsbookSelectionCode } from "@/lib/sportsbook";

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

export function BetSlipProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = React.useState<SlipLeg[]>([]);
  const [hydrated, setHydrated] = React.useState(false);

  // Load once on mount. localStorage isn't available during SSR, so hydrating
  // from it is the canonical effect-setState exception (can't be done in
  // render or a lazy initializer without a server/client mismatch).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration
        if (Array.isArray(parsed)) setLegs(parsed);
      }
    } catch {
      // ignore malformed storage
    }
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
