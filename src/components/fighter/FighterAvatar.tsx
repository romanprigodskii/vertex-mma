import Image from "next/image";

import { cn } from "@/lib/utils";

type AvatarSize = "sm" | "md" | "lg" | "xl" | "2xl";

interface FighterAvatarProps {
  name: string;
  photoUrl: string | null;
  size?: AvatarSize;
  className?: string;
  /** Override the default sizes attr for next/image. */
  imageSizes?: string;
  /** Eager-load the image when above the fold. */
  priority?: boolean;
}

const PX: Record<AvatarSize, number> = {
  sm: 48,
  md: 64,
  lg: 80,
  xl: 100,
  "2xl": 140,
};
const INITIAL_TEXT_PX: Record<AvatarSize, string> = {
  sm: "text-[18px]",
  md: "text-[24px]",
  lg: "text-[32px]",
  xl: "text-[40px]",
  "2xl": "text-[48px]",
};

// MMA-appropriate dark palette in OKLCH. Each is dark enough that white initials
// stay readable while still feeling distinct from background-elevated.
const PALETTE: readonly string[] = [
  "oklch(0.35 0.12 27)", // red-deep
  "oklch(0.35 0.10 70)", // gold-deep
  "oklch(0.30 0.08 250)", // blue-deep
  "oklch(0.30 0.10 310)", // purple-deep
  "oklch(0.30 0.10 150)", // green-deep
  "oklch(0.25 0.02 240)", // neutral-deep
];

function getColorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Photo when available, otherwise a consistently-colored initials tile.
 * Replaces the old silhouette-SVG fallback — every fighter renders something.
 */
export function FighterAvatar({
  name,
  photoUrl,
  size = "md",
  className,
  imageSizes,
  priority,
}: FighterAvatarProps) {
  const dimension = PX[size];
  const wrapperClass = cn(
    "relative shrink-0 overflow-hidden rounded-md border border-foreground/10",
    className,
  );

  if (photoUrl) {
    return (
      <div
        className={wrapperClass}
        style={{ width: dimension, height: dimension }}
      >
        <Image
          src={photoUrl}
          alt=""
          fill
          sizes={imageSizes ?? `${dimension}px`}
          priority={priority}
          // Unified photo treatment — desaturated + dimmed at rest so the
          // catalog reads as one visual set even though source photos vary
          // in lighting and era. Hovering the parent card (group) lifts the
          // filter back to neutral and a hair brighter. Filters are GPU-cheap
          // and transition smoothly.
          className="object-cover object-top grayscale-[20%] brightness-[0.92] transition-[filter] duration-300 ease-out group-hover:grayscale-0 group-hover:brightness-105 group-focus-visible:grayscale-0 group-focus-visible:brightness-105"
        />
      </div>
    );
  }

  const color = getColorForName(name);
  const initials = getInitials(name);
  return (
    <div
      className={wrapperClass}
      style={{
        width: dimension,
        height: dimension,
        backgroundColor: color,
      }}
      aria-hidden
    >
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center font-sans font-bold uppercase tracking-wider text-foreground/90",
          INITIAL_TEXT_PX[size],
        )}
      >
        {initials}
      </span>
    </div>
  );
}
