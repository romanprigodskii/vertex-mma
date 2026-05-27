"use client";

import { useTranslations } from "next-intl";

import { BoutHeatmap } from "@/components/bout/BoutHeatmap";
import { BoutPositionBreakdown } from "@/components/bout/BoutPositionBreakdown";
import { Container } from "@/components/layout/container";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  BoutDetailFighter,
  FighterPositionMap,
  FighterStrikeMap,
} from "@/lib/bout-detail";

interface BoutStrikeAnalysisProps {
  fighterA: BoutDetailFighter;
  fighterB: BoutDetailFighter;
  landedA: FighterStrikeMap;
  landedB: FighterStrikeMap;
  absorbedA: FighterStrikeMap;
  absorbedB: FighterStrikeMap;
  positionA: FighterPositionMap;
  positionB: FighterPositionMap;
}

export function BoutStrikeAnalysis(props: BoutStrikeAnalysisProps) {
  const t = useTranslations("bout");
  const strikeLabels = {
    head: t("head"),
    body: t("body"),
    legs: t("legs"),
  };
  const positionLabels = {
    distance: t("distance"),
    clinch: t("clinch"),
    ground: t("ground"),
  };
  return (
    <section
      aria-label={t("strikeAnalysis")}
      className="border-t border-foreground/[0.06] py-10 md:py-14"
    >
      <Container size="xl">
        <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("strikeAnalysis")}
        </h2>
        <Tabs defaultValue="landed">
          <TabsList className="mb-5">
            <TabsTrigger value="landed">{t("landed")}</TabsTrigger>
            <TabsTrigger value="absorbed">{t("absorbed")}</TabsTrigger>
            <TabsTrigger value="position">{t("byPosition")}</TabsTrigger>
          </TabsList>
          <TabsContent value="landed">
            <BoutHeatmap
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.landedA}
              mapB={props.landedB}
              colorClass="text-streak-loss"
              labels={strikeLabels}
            />
          </TabsContent>
          <TabsContent value="absorbed">
            <BoutHeatmap
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.absorbedA}
              mapB={props.absorbedB}
              colorClass="text-foreground-muted"
              labels={strikeLabels}
            />
          </TabsContent>
          <TabsContent value="position">
            <BoutPositionBreakdown
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.positionA}
              mapB={props.positionB}
              labels={positionLabels}
            />
          </TabsContent>
        </Tabs>
      </Container>
    </section>
  );
}
