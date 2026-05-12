import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRecord(wins: number, losses: number, draws = 0): string {
  return `${wins}-${losses}-${draws}`;
}

export function formatCoins(amount: number): string {
  return new Intl.NumberFormat("en-US").format(Math.trunc(amount));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
