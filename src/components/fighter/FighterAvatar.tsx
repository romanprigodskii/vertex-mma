import Image from "next/image";

import { getAvatarBg, getAvatarInitials } from "@/lib/avatar-palette";
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
    "relative shrink-0 overflow-hidden rounded-md border border-edge",
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

  const color = getAvatarBg(name);
  const initials = getAvatarInitials(name);
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
          "absolute inset-0 flex items-center justify-center font-broadcast-display font-bold uppercase tracking-wider text-fg-muted",
          INITIAL_TEXT_PX[size],
        )}
      >
        {initials}
      </span>
    </div>
  );
}
