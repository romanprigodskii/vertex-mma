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

/** Validate one raw object into a SlipLeg, or null if malformed. Reads the
 *  persisted full-shape keys ({ boutId, code, odds, … }); the share-link path
 *  remaps its compact keys onto this shape so both flow through one validator. */
function sanitizeLeg(raw: unknown): SlipLeg | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const boutId = String(o.boutId ?? "");
  const code = String(o.code ?? "");
  if (!UUID_RE.test(boutId) || !isSelectionCode(code)) return null;
  const odds = Number(o.odds);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  return {
    boutId,
    code: code as SportsbookSelectionCode,
    odds,
    boutLabel: String(o.boutLabel ?? "").slice(0, 120),
    pickLabel: String(o.pickLabel ?? "").slice(0, 120),
  };
}

/** Validate + dedupe (one leg per bout) + cap a list of raw legs. Returns null
 *  when nothing survives, so both load paths can fall through cleanly. */
function sanitizeLegs(items: unknown): SlipLeg[] | null {
  if (!Array.isArray(items)) return null;
  const seen = new Set<string>();
  const legs: SlipLeg[] = [];
  for (const item of items) {
    const leg = sanitizeLeg(item);
    if (!leg || seen.has(leg.boutId)) continue; // one leg per bout
    seen.add(leg.boutId);
    legs.push(leg);
    if (legs.length >= MAX_PARLAY_LEGS) break;
  }
  return legs.length > 0 ? legs : null;
}

/** Parse + sanitise a shared slip param. Returns null on anything malformed. */
export function decodeSlip(raw: string): SlipLeg[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Share links use compact keys; remap to the persisted shape, then run the
    // exact same validation as a localStorage restore.
    return sanitizeLegs(
      parsed.map((item) => {
        if (!item || typeof item !== "object") return null;
        const o = item as Record<string, unknown>;
        return {
          boutId: o.b,
          code: o.c,
          odds: o.o,
          boutLabel: o.bl,
          pickLabel: o.pl,
        };
      }),
    );
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
        if (raw) loaded = sanitizeLegs(JSON.parse(raw));
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
