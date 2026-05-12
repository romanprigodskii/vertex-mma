import * as dotenv from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

import * as schema from "./schema";
import {
  bout,
  event,
  fighter,
  fighterStatsAggregate,
  market,
  marketOutcome,
} from "./schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = postgres(url, { prepare: false });
  const db = drizzle(client, { schema });

  console.log("Seeding fighters…");

  const fighterRows = [
    {
      slug: "khabib-nurmagomedov",
      nameEn: "Khabib Nurmagomedov",
      nameRu: "Хабиб Нурмагомедов",
      nickname: "The Eagle",
      dob: "1988-09-20",
      heightCm: 178,
      reachCm: 178,
      legReachCm: 102,
      stance: "orthodox" as const,
      countryCode: "RU",
      fightingOutOf: "Dagestan, Russia",
      weightClassPrimary: "lightweight" as const,
      status: "retired" as const,
      careerStart: "2008-09-13",
      careerEnd: "2020-10-24",
    },
    {
      slug: "conor-mcgregor",
      nameEn: "Conor McGregor",
      nameRu: "Конор Макгрегор",
      nickname: "The Notorious",
      dob: "1988-07-14",
      heightCm: 175,
      reachCm: 188,
      legReachCm: 102,
      stance: "southpaw" as const,
      countryCode: "IE",
      fightingOutOf: "Dublin, Ireland",
      weightClassPrimary: "lightweight" as const,
      status: "active" as const,
      careerStart: "2008-03-08",
    },
    {
      slug: "islam-makhachev",
      nameEn: "Islam Makhachev",
      nameRu: "Ислам Махачев",
      nickname: undefined,
      dob: "1991-10-27",
      heightCm: 178,
      reachCm: 178,
      legReachCm: 102,
      stance: "orthodox" as const,
      countryCode: "RU",
      fightingOutOf: "Dagestan, Russia",
      weightClassPrimary: "lightweight" as const,
      status: "active" as const,
      careerStart: "2010-09-25",
    },
    {
      slug: "alexander-volkanovski",
      nameEn: "Alexander Volkanovski",
      nameRu: "Александр Волкановски",
      nickname: "The Great",
      dob: "1988-09-29",
      heightCm: 168,
      reachCm: 183,
      legReachCm: 95,
      stance: "orthodox" as const,
      countryCode: "AU",
      fightingOutOf: "Wollongong, Australia",
      weightClassPrimary: "featherweight" as const,
      status: "active" as const,
      careerStart: "2012-05-12",
    },
  ];

  const insertedFighters = await db
    .insert(fighter)
    .values(fighterRows)
    .onConflictDoNothing({ target: fighter.slug })
    .returning();

  // For idempotency: re-select all four by slug to get ids even if conflict skipped insert.
  const allFighters = await Promise.all(
    fighterRows.map(async (row) => {
      const [existing] = await db
        .select()
        .from(fighter)
        .where(eq(fighter.slug, row.slug));
      if (!existing)
        throw new Error(`Fighter ${row.slug} not found after upsert`);
      return existing;
    }),
  );

  console.log(
    `  ${insertedFighters.length} new fighters inserted, ${allFighters.length} total resolved.`,
  );

  const byslug = Object.fromEntries(allFighters.map((f) => [f.slug, f]));
  const khabib = byslug["khabib-nurmagomedov"];
  const mcgregor = byslug["conor-mcgregor"];
  const islam = byslug["islam-makhachev"];
  const volk = byslug["alexander-volkanovski"];

  console.log("Seeding fighter aggregates…");

  await db
    .insert(fighterStatsAggregate)
    .values([
      {
        fighterId: khabib.id,
        winsTotal: 29,
        lossesTotal: 0,
        winsKo: 8,
        winsSub: 11,
        winsDec: 10,
        slpm: 4.1,
        strAcc: 0.49,
        sapm: 1.75,
        strDef: 0.65,
        tdAvg: 5.32,
        tdAcc: 0.48,
        tdDef: 0.85,
        subAvg: 0.8,
        overallRating: 99,
        strikingRating: 78,
        grapplingRating: 99,
        cardioRating: 92,
        chinRating: 90,
        powerRating: 80,
        iqRating: 95,
      },
      {
        fighterId: mcgregor.id,
        winsTotal: 22,
        lossesTotal: 6,
        winsKo: 19,
        winsSub: 1,
        winsDec: 2,
        lossesKo: 1,
        lossesSub: 4,
        lossesDec: 1,
        slpm: 5.32,
        strAcc: 0.49,
        sapm: 4.66,
        strDef: 0.54,
        tdAvg: 0.67,
        tdAcc: 0.56,
        tdDef: 0.67,
        subAvg: 0.4,
        overallRating: 89,
        strikingRating: 95,
        grapplingRating: 65,
        cardioRating: 70,
        chinRating: 78,
        powerRating: 96,
        iqRating: 88,
      },
      {
        fighterId: islam.id,
        winsTotal: 26,
        lossesTotal: 1,
        winsKo: 5,
        winsSub: 11,
        winsDec: 10,
        slpm: 2.81,
        strAcc: 0.55,
        sapm: 2.05,
        strDef: 0.59,
        tdAvg: 3.05,
        tdAcc: 0.65,
        tdDef: 0.76,
        subAvg: 1.4,
        overallRating: 96,
        strikingRating: 82,
        grapplingRating: 96,
        cardioRating: 90,
        chinRating: 86,
        powerRating: 80,
        iqRating: 92,
      },
      {
        fighterId: volk.id,
        winsTotal: 26,
        lossesTotal: 4,
        winsKo: 12,
        winsSub: 3,
        winsDec: 11,
        lossesKo: 2,
        lossesSub: 0,
        lossesDec: 2,
        slpm: 6.0,
        strAcc: 0.55,
        sapm: 3.31,
        strDef: 0.6,
        tdAvg: 1.66,
        tdAcc: 0.4,
        tdDef: 0.74,
        subAvg: 0.3,
        overallRating: 95,
        strikingRating: 93,
        grapplingRating: 82,
        cardioRating: 98,
        chinRating: 90,
        powerRating: 85,
        iqRating: 95,
      },
    ])
    .onConflictDoNothing({ target: fighterStatsAggregate.fighterId });

  console.log("Seeding event…");

  const eventDate = new Date();
  eventDate.setMonth(eventDate.getMonth() + 2);

  const [evt] = await db
    .insert(event)
    .values({
      slug: "ufc-test",
      name: "UFC TEST",
      shortName: "UFC TEST",
      promotion: "ufc",
      date: eventDate,
      locationCity: "Las Vegas",
      locationCountry: "US",
      venue: "T-Mobile Arena",
      status: "upcoming",
    })
    .onConflictDoNothing({ target: event.slug })
    .returning();

  const [eventRow] = evt
    ? [evt]
    : await db.select().from(event).where(eq(event.slug, "ufc-test"));

  console.log(`  event id: ${eventRow.id}`);

  console.log("Seeding bout…");

  const existingBout = await db
    .select()
    .from(bout)
    .where(
      and(
        eq(bout.eventId, eventRow.id),
        eq(bout.fighterAId, islam.id),
        eq(bout.fighterBId, volk.id),
      ),
    );

  let boutRow = existingBout[0];
  if (!boutRow) {
    const [inserted] = await db
      .insert(bout)
      .values({
        eventId: eventRow.id,
        fighterAId: islam.id,
        fighterBId: volk.id,
        weightClass: "lightweight",
        isTitleFight: true,
        isMainEvent: true,
        scheduledRounds: 5,
        boutOrder: 1,
        status: "scheduled",
      })
      .returning();
    boutRow = inserted;
  }

  console.log(`  bout id: ${boutRow.id}`);

  console.log("Seeding market…");

  const existingMarket = await db
    .select()
    .from(market)
    .where(and(eq(market.boutId, boutRow.id), eq(market.type, "winner")));

  let marketRow = existingMarket[0];
  if (!marketRow) {
    const closesAt = new Date(eventDate.getTime() - 60 * 60 * 1000);
    const [inserted] = await db
      .insert(market)
      .values({
        boutId: boutRow.id,
        type: "winner",
        question: "Who wins Islam Makhachev vs Alexander Volkanovski?",
        status: "open",
        bParameter: 100,
        closesAt,
      })
      .returning();
    marketRow = inserted;
  }

  console.log(`  market id: ${marketRow.id}`);

  console.log("Seeding market outcomes…");

  const existingOutcomes = await db
    .select()
    .from(marketOutcome)
    .where(eq(marketOutcome.marketId, marketRow.id));

  if (existingOutcomes.length === 0) {
    await db.insert(marketOutcome).values([
      {
        marketId: marketRow.id,
        label: "Islam Makhachev",
        orderIndex: 0,
        currentShares: 0,
        currentPrice: 0.62,
      },
      {
        marketId: marketRow.id,
        label: "Alexander Volkanovski",
        orderIndex: 1,
        currentShares: 0,
        currentPrice: 0.38,
      },
    ]);
  }

  console.log("Done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
