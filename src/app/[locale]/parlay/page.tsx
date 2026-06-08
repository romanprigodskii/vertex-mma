import { redirect } from "@/i18n/navigation";

interface PageProps {
  params: Promise<{ locale: string }>;
}

// Parlays are personal bet slips — surfaced from /me/bets and the bet-slip
// widget, with no public index. A bare /parlay URL (e.g. a shared link with the
// id trimmed off) previously dead-ended on a 404; send it to the markets board,
// where a parlay is actually built.
export default async function ParlayIndexPage({ params }: PageProps) {
  const { locale } = await params;
  redirect({ href: "/markets", locale });
}
