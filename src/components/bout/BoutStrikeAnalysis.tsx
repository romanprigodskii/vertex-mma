"use client";

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
  return (
    <section
      aria-label="Strike analysis"
      className="border-t border-foreground/[0.06] py-10 md:py-14"
    >
      <Container size="xl">
        <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Strike analysis
        </h2>
        <Tabs defaultValue="landed">
          <TabsList className="mb-5">
            <TabsTrigger value="landed">Landed</TabsTrigger>
            <TabsTrigger value="absorbed">Absorbed</TabsTrigger>
            <TabsTrigger value="position">By position</TabsTrigger>
          </TabsList>
          <TabsContent value="landed">
            <BoutHeatmap
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.landedA}
              mapB={props.landedB}
              colorClass="text-streak-loss"
            />
          </TabsContent>
          <TabsContent value="absorbed">
            <BoutHeatmap
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.absorbedA}
              mapB={props.absorbedB}
              colorClass="text-foreground-muted"
            />
          </TabsContent>
          <TabsContent value="position">
            <BoutPositionBreakdown
              fighterA={props.fighterA}
              fighterB={props.fighterB}
              mapA={props.positionA}
              mapB={props.positionB}
            />
          </TabsContent>
        </Tabs>
      </Container>
    </section>
  );
}
