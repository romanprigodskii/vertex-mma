import { ArrowRight, Search, Swords, Trophy } from "lucide-react";

import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { Container } from "@/components/layout/container";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Swatch = {
  name: string;
  varName: string;
  className: string;
  foreground?: string;
};

const COLOR_GROUPS: Array<{ title: string; swatches: Swatch[] }> = [
  {
    title: "Background",
    swatches: [
      { name: "background-base", varName: "--color-background-base", className: "bg-background-base border border-border" },
      { name: "background-elevated", varName: "--color-background-elevated", className: "bg-background-elevated border border-border" },
      { name: "background-overlay", varName: "--color-background-overlay", className: "bg-background-overlay border border-border" },
    ],
  },
  {
    title: "Foreground",
    swatches: [
      { name: "foreground", varName: "--color-foreground", className: "bg-foreground", foreground: "text-background-base" },
      { name: "foreground-muted", varName: "--color-foreground-muted", className: "bg-foreground-muted", foreground: "text-background-base" },
      { name: "foreground-subtle", varName: "--color-foreground-subtle", className: "bg-foreground-subtle", foreground: "text-background-base" },
    ],
  },
  {
    title: "Brand",
    swatches: [
      { name: "primary", varName: "--color-primary", className: "bg-primary", foreground: "text-primary-foreground" },
      { name: "primary-hover", varName: "--color-primary-hover", className: "bg-primary-hover", foreground: "text-primary-foreground" },
      { name: "gold", varName: "--color-gold", className: "bg-gold", foreground: "text-gold-foreground" },
    ],
  },
  {
    title: "Semantic",
    swatches: [
      { name: "success", varName: "--color-success", className: "bg-success", foreground: "text-background-base" },
      { name: "danger", varName: "--color-danger", className: "bg-danger", foreground: "text-foreground" },
      { name: "warning", varName: "--color-warning", className: "bg-warning", foreground: "text-background-base" },
      { name: "info", varName: "--color-info", className: "bg-info", foreground: "text-foreground" },
    ],
  },
  {
    title: "Borders",
    swatches: [
      { name: "border", varName: "--color-border", className: "bg-border" },
      { name: "border-strong", varName: "--color-border-strong", className: "bg-border-strong" },
    ],
  },
  {
    title: "Tier",
    swatches: [
      { name: "tier-bronze", varName: "--color-tier-bronze", className: "bg-tier-bronze", foreground: "text-foreground" },
      { name: "tier-silver", varName: "--color-tier-silver", className: "bg-tier-silver", foreground: "text-background-base" },
      { name: "tier-gold", varName: "--color-tier-gold", className: "bg-tier-gold", foreground: "text-gold-foreground" },
      { name: "tier-diamond", varName: "--color-tier-diamond", className: "bg-tier-diamond", foreground: "text-background-base" },
      { name: "tier-champion", varName: "--color-tier-champion", className: "bg-tier-champion", foreground: "text-foreground" },
    ],
  },
];

const TYPE_SCALE = [
  { name: "text-9xl", className: "text-9xl font-sans font-bold" },
  { name: "text-8xl", className: "text-8xl font-sans font-bold" },
  { name: "text-7xl", className: "text-7xl font-sans font-bold" },
  { name: "text-6xl", className: "text-6xl font-sans font-bold" },
  { name: "text-5xl", className: "text-5xl font-sans font-bold" },
  { name: "text-4xl", className: "text-4xl" },
  { name: "text-3xl", className: "text-3xl" },
  { name: "text-2xl", className: "text-2xl" },
  { name: "text-xl", className: "text-xl" },
  { name: "text-lg", className: "text-lg" },
  { name: "text-base", className: "text-base" },
  { name: "text-sm", className: "text-sm" },
  { name: "text-xs", className: "text-xs" },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="py-16 border-t border-border first:border-t-0">
      <Container size="xl">
        <div className="mb-8 flex flex-col gap-2">
          <h2 className="font-sans font-bold text-4xl md:text-5xl tracking-wide text-foreground">
            {title}
          </h2>
          {description && (
            <p className="text-foreground-muted max-w-2xl">{description}</p>
          )}
        </div>
        {children}
      </Container>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <Container size="xl" className="py-24 md:py-32 lg:py-40">
            <div className="flex flex-col items-center text-center gap-6">
              <Badge variant="primary" size="default">
                Wave 1 — Design System
              </Badge>
              <h1 className="font-sans font-bold text-7xl sm:text-8xl md:text-9xl tracking-wider leading-none">
                <span className="text-primary">V</span>
                <span className="text-foreground">ERTEX</span>
              </h1>
              <p className="text-xl md:text-2xl text-foreground-muted max-w-2xl">
                AI-powered MMA fight simulator
              </p>
              <div className="mt-4 flex flex-col sm:flex-row items-center gap-3">
                <Button size="xl">
                  Start Simulation
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button size="xl" variant="ghost">
                  Browse Fighters
                </Button>
              </div>
            </div>
          </Container>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-24 h-[420px] bg-[radial-gradient(ellipse_at_top,_oklch(0.62_0.22_27/0.20),_transparent_60%)]"
          />
        </section>

        {/* Palette */}
        <Section
          id="palette"
          title="Palette"
          description="OKLCH tokens defined in globals.css via @theme. Each swatch shows the token name and CSS variable."
        >
          <div className="grid gap-8">
            {COLOR_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                  {group.title}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {group.swatches.map((s) => (
                    <div
                      key={s.name}
                      className="flex flex-col rounded-xl overflow-hidden border border-border"
                    >
                      <div
                        className={`h-20 flex items-end p-3 ${s.className} ${s.foreground ?? ""}`}
                      >
                        <span className="text-xs font-medium font-mono">
                          {s.name}
                        </span>
                      </div>
                      <div className="bg-background-elevated px-3 py-2 text-[10px] font-mono text-foreground-subtle truncate">
                        {s.varName}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Typography */}
        <Section
          id="typography"
          title="Typography"
          description="Inter for UI and headlines, JetBrains Mono for numbers and code."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Type scale</CardTitle>
                <CardDescription>From 9xl to xs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {TYPE_SCALE.map((t) => (
                  <div
                    key={t.name}
                    className="flex items-baseline gap-4 border-b border-border last:border-0 pb-2 last:pb-0"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-foreground-subtle w-16 shrink-0">
                      {t.name}
                    </span>
                    <span className={`${t.className} truncate`}>Vertex</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Families</CardTitle>
                <CardDescription>
                  font-sans, font-mono
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-xs font-mono text-foreground-subtle mb-1">
                    font-sans bold — Inter
                  </p>
                  <p className="font-sans font-bold text-5xl tracking-tight">
                    Conor McGregor
                  </p>
                </div>
                <Separator />
                <div>
                  <p className="text-xs font-mono text-foreground-subtle mb-1">
                    font-sans — Inter
                  </p>
                  <p className="font-sans text-base">
                    The Notorious is one of the most polarizing fighters in MMA.
                  </p>
                </div>
                <Separator />
                <div>
                  <p className="text-xs font-mono text-foreground-subtle mb-1">
                    font-mono — JetBrains Mono · tabular
                  </p>
                  <p className="font-mono text-xl tabular">
                    27 - 0 - 0 · 1,234 coins · 73.2%
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* Buttons */}
        <Section
          id="buttons"
          title="Buttons"
          description="Six variants × five sizes with loading and disabled states."
        >
          <div className="grid gap-8">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                Variants
              </h4>
              <div className="flex flex-wrap gap-3">
                <Button>Default</Button>
                <Button variant="gold">Gold</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="link">Link</Button>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                Sizes
              </h4>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button>Default</Button>
                <Button size="lg">Large</Button>
                <Button size="xl">Extra large</Button>
                <Button size="icon" aria-label="Search">
                  <Search />
                </Button>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                States
              </h4>
              <div className="flex flex-wrap gap-3">
                <Button loading>Loading</Button>
                <Button disabled>Disabled</Button>
                <Button>
                  <Swords />
                  With icon
                </Button>
                <Button variant="gold">
                  <Trophy />
                  Champion
                </Button>
              </div>
            </div>
          </div>
        </Section>

        {/* Cards */}
        <Section
          id="cards"
          title="Cards"
          description="background-elevated, rounded-xl. Hoverable variant lifts toward background-overlay."
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Static card</CardTitle>
                <CardDescription>
                  Default presentation, no hover state.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-foreground-muted">
                  Use for content that does not need interaction affordance.
                </p>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
                <Button size="sm">Confirm</Button>
              </CardFooter>
            </Card>

            <Card hoverable>
              <CardHeader>
                <CardTitle>Hoverable card</CardTitle>
                <CardDescription>
                  Border and surface lift on hover.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-foreground-muted">
                  Use for clickable rows like fighter cards or fight previews.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center gap-3 space-y-0">
                <Avatar>
                  <AvatarImage src="" alt="" />
                  <AvatarFallback>CM</AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-base">Conor McGregor</CardTitle>
                  <CardDescription className="font-mono tabular">
                    22-6-0 · Lightweight
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                <Badge variant="primary">Striker</Badge>
                <Badge variant="gold">Former champ</Badge>
                <Badge variant="outline">Southpaw</Badge>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* Badges */}
        <Section
          id="badges"
          title="Badges"
          description="Variants for status, semantics, and user tiers."
        >
          <div className="grid gap-6">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                Variants
              </h4>
              <div className="flex flex-wrap gap-2">
                <Badge>Default</Badge>
                <Badge variant="primary">Primary</Badge>
                <Badge variant="gold">Gold</Badge>
                <Badge variant="success">Success</Badge>
                <Badge variant="danger">Danger</Badge>
                <Badge variant="outline">Outline</Badge>
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                Tiers
              </h4>
              <div className="flex flex-wrap gap-2">
                <Badge variant="tier-bronze">Bronze</Badge>
                <Badge variant="tier-silver">Silver</Badge>
                <Badge variant="tier-gold">Gold</Badge>
                <Badge variant="tier-diamond">Diamond</Badge>
                <Badge variant="tier-champion">Champion</Badge>
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle mb-3">
                Sizes
              </h4>
              <div className="flex flex-wrap items-center gap-2">
                <Badge size="sm" variant="primary">
                  Small
                </Badge>
                <Badge size="default" variant="primary">
                  Default
                </Badge>
              </div>
            </div>
          </div>
        </Section>

        {/* Inputs */}
        <Section
          id="inputs"
          title="Inputs & Tabs"
          description="Dark surface with primary focus ring."
        >
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Sample form</CardTitle>
                <CardDescription>
                  Inputs honor the design tokens.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wider text-foreground-subtle">
                    Search fighter
                  </label>
                  <Input placeholder="e.g. Khabib Nurmagomedov" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wider text-foreground-subtle">
                    Bet amount
                  </label>
                  <Input
                    type="number"
                    placeholder="0"
                    className="font-mono tabular"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wider text-foreground-subtle">
                    Disabled
                  </label>
                  <Input disabled value="Read only" readOnly />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tabs</CardTitle>
                <CardDescription>Radix-driven, themed surface.</CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="stats">
                  <TabsList>
                    <TabsTrigger value="stats">Stats</TabsTrigger>
                    <TabsTrigger value="history">History</TabsTrigger>
                    <TabsTrigger value="news">News</TabsTrigger>
                  </TabsList>
                  <TabsContent
                    value="stats"
                    className="text-sm text-foreground-muted"
                  >
                    Striking accuracy, takedown defense, control time —
                    placeholder content.
                  </TabsContent>
                  <TabsContent
                    value="history"
                    className="text-sm text-foreground-muted"
                  >
                    Last five bouts, opponents, outcomes — placeholder content.
                  </TabsContent>
                  <TabsContent
                    value="news"
                    className="text-sm text-foreground-muted"
                  >
                    Latest LLM-aggregated news — placeholder content.
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* Skeleton */}
        <Section
          id="skeleton"
          title="Skeleton"
          description="Loading affordance for content placeholders."
        >
          <Card>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        </Section>
      </main>
      <Footer />
    </>
  );
}
