/**
 * Seed two sportsbook achievements (idempotent — NOT EXISTS guard per row,
 * so re-running is a no-op). Mirrors the seed format in drizzle migration
 * 0060_wave40_engagement.sql. The unlock conditions live in
 * src/lib/achievements.ts (checkAndUnlockAchievements).
 *
 * Usage: npx tsx scripts/apply_sportsbook_achievements.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { prepare: false, max: 1 });

async function main() {
  await sql`
    INSERT INTO achievement (slug, name, description, reward_coins, rarity)
    SELECT v.slug, v.name, v.description, v.reward_coins, v.rarity
    FROM (VALUES
      ('parlay_win', 'Parlay Hit', 'Won a parlay — every leg landed.', 750, 'rare'),
      ('underdog_win', 'Upset Special', 'Won a sportsbook bet at 3.00+ odds.', 600, 'uncommon')
    ) AS v(slug, name, description, reward_coins, rarity)
    WHERE NOT EXISTS (SELECT 1 FROM achievement a WHERE a.slug = v.slug)
  `;
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM achievement WHERE slug IN ('parlay_win', 'underdog_win')
  `;
  console.log("sportsbook achievements present:", rows.map((r) => r.slug).join(", "));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
