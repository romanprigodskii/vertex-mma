/**
 * Curated UFC championship history.
 *
 * Why this exists: the source data has no notion of "did a fighter ever hold a
 * UFC belt." We need it for the Vertex Score's Championship Pedigree
 * component AND for tier classification (Active / Dominant / Former champion
 * sub-tiers introduced in Wave 3.5 step 4A). The list below is built from
 * researched UFC title history and intersected with fighter slugs that
 * actually exist in our DB — fighters not in the DB are silently skipped.
 *
 * Each entry covers ONE reign for ONE fighter. Multi-reign champs (Stipe,
 * GSP, DC, Hughes, Nunes, etc.) get one entry per reign so the dates remain
 * accurate for any future "days as champion" / chronology features.
 *
 * `endDate` is null when the fighter is still champion. Vacated belts use the
 * vacate date; interim belts that were promoted to undisputed are recorded as
 * the start of the undisputed reign (we don't split interim→undisputed
 * transitions into separate rows for the same continuous reign).
 *
 * `defenses` is the count of successful title defenses *during this specific
 * reign* — i.e. wins that retained the belt. It excludes the initial title
 * win (that's accounted for by the row existing) and excludes losses /
 * vacates. Wave 3.5 step 4A's tier classifier uses `totalDefenses(slug) >= 3`
 * to flag "dominant" champions (Anderson, GSP, Khabib, DJ, Volk, Aldo, etc.)
 * regardless of weight class.
 */

export type WeightClass =
  | "strawweight"
  | "flyweight"
  | "bantamweight"
  | "featherweight"
  | "lightweight"
  | "welterweight"
  | "middleweight"
  | "light_heavyweight"
  | "heavyweight";

export interface ChampionshipReign {
  slug: string;
  weightClass: WeightClass;
  /** Date the fighter won the belt (ISO yyyy-mm-dd). */
  startDate: string;
  /** Date the reign ended — null if still champion. */
  endDate: string | null;
  /** Successful title defenses during this reign (excludes the win itself). */
  defenses: number;
  /** True for interim-title reigns that were not later promoted to undisputed. */
  isInterim?: boolean;
  /**
   * Wave 6E.2 — how this reign ended. Drives the CP "stickiness" rule in
   * scripts/compute_championship_pedigree.ts: a champion who vacated or was
   * stripped (career decision, not a result on the canvas) keeps CP=100 until
   * their NEXT bout, then drops to 80. A champion who lost the belt in a fight
   * or retired holding it drops to 80 immediately.
   *
   *   'lost_bout' — beaten in a title fight (default when undefined)
   *   'vacated'   — voluntarily gave up the belt
   *   'stripped'  — UFC stripped the belt (weight miss, PED, inactivity, etc.)
   *   'retired'   — fighter retired holding the belt (no future bouts ⇒ CP=80)
   */
  endReason?: "lost_bout" | "vacated" | "stripped" | "retired";
}

export const CHAMPIONSHIP_HISTORY: readonly ChampionshipReign[] = [
  // ============================================================
  // HEAVYWEIGHT
  // ============================================================
  // Wave 11: full interim sync. Aspinall split back into interim (UFC 295
  // 2023-11-11 vs Pavlovich) and undisputed (elevated 2025-06-21 when Jones
  // retired). Blaydes KO at UFC 304 (2024-07-27) was during the interim
  // phase. UFC 321 (2025-10-25) vs Gane was a NC, not a defense.
  { slug: "tom-aspinall-399afb",     weightClass: "heavyweight", startDate: "2025-06-21", endDate: null,         defenses: 0 }, // undisputed phase
  { slug: "tom-aspinall-399afb",     weightClass: "heavyweight", startDate: "2023-11-11", endDate: "2025-06-21", defenses: 1, isInterim: true }, // interim — Blaydes UFC 304; elevated when Jones retired
  { slug: "jon-jones-07f72a",        weightClass: "heavyweight", startDate: "2023-03-04", endDate: "2025-06-21", defenses: 1, endReason: "retired" }, // vs Stipe; then retired holding the belt
  { slug: "ciryl-gane-787bb1",       weightClass: "heavyweight", startDate: "2021-08-07", endDate: "2022-01-22", defenses: 0, isInterim: true }, // UFC 265 vs Lewis; lost unification vs Ngannou at UFC 270
  { slug: "francis-ngannou-8d03ce",  weightClass: "heavyweight", startDate: "2021-03-27", endDate: "2023-01-14", defenses: 1, endReason: "vacated" }, // vs Gane; vacated, left UFC
  { slug: "stipe-miocic-d28dee",     weightClass: "heavyweight", startDate: "2019-08-17", endDate: "2021-03-27", defenses: 1 }, // reign 2 — vs DC 3
  { slug: "daniel-cormier-d967f0",   weightClass: "heavyweight", startDate: "2018-07-07", endDate: "2019-08-17", defenses: 1 }, // vs Lewis
  { slug: "stipe-miocic-d28dee",     weightClass: "heavyweight", startDate: "2016-05-14", endDate: "2018-07-07", defenses: 3 }, // reign 1 — Overeem, JDS 2, Ngannou
  { slug: "fabricio-werdum-492b20",  weightClass: "heavyweight", startDate: "2015-06-13", endDate: "2016-05-14", defenses: 0 }, // undisputed (def. Velasquez UFC 188)
  { slug: "fabricio-werdum-492b20",  weightClass: "heavyweight", startDate: "2014-11-15", endDate: "2015-06-13", defenses: 0, isInterim: true }, // UFC 180 vs Hunt; unified at UFC 188
  { slug: "cain-velasquez-0ff11c",   weightClass: "heavyweight", startDate: "2012-12-29", endDate: "2015-06-13", defenses: 2 }, // reign 2 — Bigfoot 2, JDS 3
  { slug: "junior-dos-santos-63def5", weightClass: "heavyweight", startDate: "2011-11-12", endDate: "2012-12-29", defenses: 1 }, // vs Mir
  { slug: "cain-velasquez-0ff11c",   weightClass: "heavyweight", startDate: "2010-10-23", endDate: "2011-11-12", defenses: 0 }, // reign 1 — lost first to JDS
  { slug: "shane-carwin-68dd7b",     weightClass: "heavyweight", startDate: "2010-03-27", endDate: "2010-07-03", defenses: 0, isInterim: true }, // UFC 111 vs Mir; lost unification vs Lesnar at UFC 116
  { slug: "frank-mir-1ff958",        weightClass: "heavyweight", startDate: "2008-12-27", endDate: "2009-07-11", defenses: 0, isInterim: true }, // UFC 92 vs Nogueira; lost unification vs Lesnar at UFC 100
  { slug: "antonio-rodrigo-nogueira-ee9d73", weightClass: "heavyweight", startDate: "2008-02-02", endDate: "2008-12-27", defenses: 0, isInterim: true }, // UFC 81 vs Sylvia; lost to Mir at UFC 92
  { slug: "brock-lesnar-513c6f",     weightClass: "heavyweight", startDate: "2008-11-15", endDate: "2010-10-23", defenses: 2 }, // Mir 2, Carwin
  { slug: "randy-couture-0aa925",    weightClass: "heavyweight", startDate: "2007-03-03", endDate: "2008-11-15", defenses: 1 }, // last HW reign — Gabriel Gonzaga
  { slug: "tim-sylvia-2a542e",       weightClass: "heavyweight", startDate: "2006-04-15", endDate: "2007-03-03", defenses: 2 }, // Monson, Mercer? — TODO verify
  { slug: "andrei-arlovski-3738e6",  weightClass: "heavyweight", startDate: "2005-08-12", endDate: "2006-04-15", defenses: 2 }, // undisputed — promoted when Mir stripped; Buentello + lost unification
  { slug: "andrei-arlovski-3738e6",  weightClass: "heavyweight", startDate: "2005-02-05", endDate: "2005-08-12", defenses: 0, isInterim: true }, // UFC 51 vs Sylvia; promoted when Mir stripped
  { slug: "frank-mir-1ff958",        weightClass: "heavyweight", startDate: "2004-06-19", endDate: "2005-08-12", defenses: 0, endReason: "stripped" }, // stripped (motorcycle injury); Wave 13: date corrected from 2005-02-05 → 2005-08-12 (actual strip date)
  { slug: "ricco-rodriguez-50cc91",  weightClass: "heavyweight", startDate: "2002-09-27", endDate: "2003-02-28", defenses: 0 },
  { slug: "josh-barnett-ad3f53",     weightClass: "heavyweight", startDate: "2002-03-22", endDate: "2002-07-26", defenses: 0, endReason: "stripped" }, // beat Couture at UFC 36; stripped (PED)
  { slug: "randy-couture-0aa925",    weightClass: "heavyweight", startDate: "2000-11-17", endDate: "2002-03-22", defenses: 0 }, // HW reign 2 — beat Randleman at UFC 28, lost to Barnett
  { slug: "kevin-randleman-6859f6",  weightClass: "heavyweight", startDate: "1999-11-19", endDate: "2000-11-17", defenses: 0 },
  { slug: "bas-rutten-03688d",       weightClass: "heavyweight", startDate: "1999-05-07", endDate: "1999-08-01", defenses: 0, endReason: "vacated" }, // vacated
  { slug: "maurice-smith-33e33d",    weightClass: "heavyweight", startDate: "1997-07-27", endDate: "1997-12-21", defenses: 1 }, // Tank Abbott
  { slug: "mark-coleman-21b8a0",     weightClass: "heavyweight", startDate: "1997-02-07", endDate: "1997-07-27", defenses: 1 }, // Dan Severn
  // Pre-1997 Superfight Openweight titles — unified with HW at UFC 12 (1997-02-07).
  // Per dev note (Wave 13): classified as heavyweight for tier/era purposes.
  { slug: "dan-severn-c670aa",       weightClass: "heavyweight", startDate: "1996-05-17", endDate: "1997-02-07", defenses: 0 }, // Superfight Openweight — beat Ken Shamrock; lost to Coleman at unification
  { slug: "ken-shamrock-63b65a",     weightClass: "heavyweight", startDate: "1995-07-14", endDate: "1996-05-17", defenses: 0 }, // inaugural Superfight Openweight; lost to Severn

  // ============================================================
  // LIGHT HEAVYWEIGHT
  // ============================================================
  { slug: "carlos-ulberg-9014c0",      weightClass: "light_heavyweight", startDate: "2026-04-11", endDate: null,         defenses: 0 }, // won vacant title vs Prochazka
  { slug: "alex-pereira-e5549c",       weightClass: "light_heavyweight", startDate: "2025-10-04", endDate: "2026-02-27", defenses: 0, endReason: "vacated" }, // reign 2 — vacated to move up to HW (Wave 13: corrected from 2026-02-28)
  { slug: "magomed-ankalaev-d80217",   weightClass: "light_heavyweight", startDate: "2025-03-08", endDate: "2025-10-04", defenses: 0 },
  { slug: "alex-pereira-e5549c",       weightClass: "light_heavyweight", startDate: "2023-11-11", endDate: "2025-03-08", defenses: 3 }, // reign 1 — Hill, Prochazka 2, Rountree
  { slug: "jamahal-hill-5444c5",       weightClass: "light_heavyweight", startDate: "2023-01-21", endDate: "2023-07-01", defenses: 0, endReason: "vacated" }, // vacated (injury)
  { slug: "jiri-prochazka-009341",     weightClass: "light_heavyweight", startDate: "2022-06-11", endDate: "2022-11-23", defenses: 0, endReason: "vacated" }, // vacated (injury)
  { slug: "glover-teixeira-7ff978",    weightClass: "light_heavyweight", startDate: "2021-10-30", endDate: "2022-06-11", defenses: 0 },
  { slug: "jan-blachowicz-99df7d",     weightClass: "light_heavyweight", startDate: "2020-09-26", endDate: "2021-10-30", defenses: 1 }, // vs Adesanya
  { slug: "jon-jones-07f72a",          weightClass: "light_heavyweight", startDate: "2018-12-29", endDate: "2020-08-17", defenses: 3 }, // reign 2 — Smith, Santos, Reyes
  { slug: "jon-jones-07f72a",          weightClass: "light_heavyweight", startDate: "2016-04-23", endDate: "2016-11-09", defenses: 0, isInterim: true, endReason: "stripped" }, // UFC 197 vs OSP; stripped (USADA suspension)
  { slug: "daniel-cormier-d967f0",     weightClass: "light_heavyweight", startDate: "2015-05-23", endDate: "2018-12-28", defenses: 4 }, // Gustafsson, Johnson 2 x2 (UFC 200/210), Volkan; reinstated after Jones PED (Wave 13: corrected from 2018-12-29)
  { slug: "jon-jones-07f72a",          weightClass: "light_heavyweight", startDate: "2011-03-19", endDate: "2015-04-28", defenses: 8, endReason: "stripped" }, // reign 1 — Rampage, Machida, Rashad, Belfort, Sonnen, Gus, Teixeira, DC; stripped (hit-and-run)
  { slug: "mauricio-rua-140745",       weightClass: "light_heavyweight", startDate: "2010-05-08", endDate: "2011-03-19", defenses: 0 },
  { slug: "lyoto-machida-f7a7f7",      weightClass: "light_heavyweight", startDate: "2009-05-23", endDate: "2010-05-08", defenses: 0 },
  { slug: "rashad-evans-ee779c",       weightClass: "light_heavyweight", startDate: "2008-12-27", endDate: "2009-05-23", defenses: 0 },
  { slug: "forrest-griffin-fcffee",    weightClass: "light_heavyweight", startDate: "2008-07-05", endDate: "2008-12-27", defenses: 0 },
  { slug: "quinton-jackson-ffc088",    weightClass: "light_heavyweight", startDate: "2007-05-26", endDate: "2008-07-05", defenses: 1 }, // Dan Henderson (UFC 75)
  { slug: "chuck-liddell-a390eb",      weightClass: "light_heavyweight", startDate: "2005-04-16", endDate: "2007-05-26", defenses: 4 }, // Couture 2, Sobral, Tito, Babalu — TODO recount
  { slug: "randy-couture-0aa925",      weightClass: "light_heavyweight", startDate: "2004-08-21", endDate: "2005-04-16", defenses: 0 }, // LHW reign 2
  { slug: "vitor-belfort-0ee783",      weightClass: "light_heavyweight", startDate: "2004-01-31", endDate: "2004-08-21", defenses: 0 },
  { slug: "randy-couture-0aa925",      weightClass: "light_heavyweight", startDate: "2003-09-26", endDate: "2004-01-31", defenses: 1 }, // LHW reign 1 — undisputed (def. Tito at UFC 44)
  { slug: "randy-couture-0aa925",      weightClass: "light_heavyweight", startDate: "2003-06-06", endDate: "2003-09-26", defenses: 0, isInterim: true }, // UFC 43 vs Liddell; promoted to undisputed at UFC 44
  { slug: "tito-ortiz-2f732d",         weightClass: "light_heavyweight", startDate: "2000-04-14", endDate: "2003-09-26", defenses: 5 }, // Kondo, Tanner, Sinosic, Matyushenko, Shamrock
  { slug: "frank-shamrock-fcaae0",     weightClass: "light_heavyweight", startDate: "1997-12-21", endDate: "1999-11-24", defenses: 4, endReason: "vacated" }, // inaugural LHW — Zinoviev, Horn, Lober, Tito Ortiz; vacated

  // ============================================================
  // MIDDLEWEIGHT
  // ============================================================
  { slug: "sean-strickland-0d8011",   weightClass: "middleweight", startDate: "2026-05-09", endDate: null,         defenses: 0 }, // reign 2 — reclaimed from Chimaev at UFC 328
  { slug: "khamzat-chimaev-767755",   weightClass: "middleweight", startDate: "2025-08-16", endDate: "2026-05-09", defenses: 0 }, // lost to Strickland 2
  { slug: "dricus-du-plessis-0d7b51", weightClass: "middleweight", startDate: "2024-01-20", endDate: "2025-08-16", defenses: 2 }, // Adesanya, Strickland 2
  { slug: "sean-strickland-0d8011",   weightClass: "middleweight", startDate: "2023-09-09", endDate: "2024-01-20", defenses: 0 },
  { slug: "israel-adesanya-1338e2",   weightClass: "middleweight", startDate: "2023-04-08", endDate: "2023-09-09", defenses: 0 }, // reign 2
  { slug: "alex-pereira-e5549c",      weightClass: "middleweight", startDate: "2022-11-12", endDate: "2023-04-08", defenses: 0 },
  { slug: "israel-adesanya-1338e2",   weightClass: "middleweight", startDate: "2019-10-05", endDate: "2022-11-12", defenses: 5 }, // reign 1 — Romero, Costa, Vettori 2, Whittaker 2, Cannonier
  { slug: "israel-adesanya-1338e2",   weightClass: "middleweight", startDate: "2019-04-13", endDate: "2019-10-05", defenses: 0, isInterim: true }, // UFC 236 vs Gastelum; unified vs Whittaker at UFC 243
  { slug: "robert-whittaker-e1147d",  weightClass: "middleweight", startDate: "2017-12-07", endDate: "2019-10-05", defenses: 1 }, // undisputed — promoted when GSP vacated; Romero 2
  { slug: "robert-whittaker-e1147d",  weightClass: "middleweight", startDate: "2017-07-08", endDate: "2017-12-07", defenses: 0, isInterim: true }, // UFC 213 vs Romero; promoted when GSP vacated
  { slug: "georges-st-pierre-6506c1", weightClass: "middleweight", startDate: "2017-11-04", endDate: "2017-12-07", defenses: 0, endReason: "vacated" }, // won, vacated
  { slug: "michael-bisping-2b93eb",   weightClass: "middleweight", startDate: "2016-06-04", endDate: "2017-11-04", defenses: 1 }, // Henderson 2
  { slug: "luke-rockhold-00e11b",     weightClass: "middleweight", startDate: "2015-12-12", endDate: "2016-06-04", defenses: 0 },
  { slug: "chris-weidman-3a8176",     weightClass: "middleweight", startDate: "2013-07-06", endDate: "2015-12-12", defenses: 3 }, // Anderson 2, Machida, Belfort
  { slug: "anderson-silva-1f4543",    weightClass: "middleweight", startDate: "2006-10-14", endDate: "2013-07-06", defenses: 10 }, // historic 10 defenses — Henderson, Lutter, Marquardt, Cote, Leites, Maia, Sonnen, Belfort, Okami, Sonnen 2
  { slug: "rich-franklin-d89789",     weightClass: "middleweight", startDate: "2005-06-04", endDate: "2006-10-14", defenses: 2 }, // Tanner 2, Loiseau
  { slug: "evan-tanner-8f2d9e",       weightClass: "middleweight", startDate: "2005-02-05", endDate: "2005-06-04", defenses: 0 },
  { slug: "murilo-bustamante-85d905", weightClass: "middleweight", startDate: "2002-01-11", endDate: "2002-08-22", defenses: 1 }, // Matt Lindland
  { slug: "dave-menne-275caf",        weightClass: "middleweight", startDate: "2001-09-28", endDate: "2002-01-11", defenses: 0 }, // inaugural MW; lost to Bustamante

  // ============================================================
  // WELTERWEIGHT
  // ============================================================
  { slug: "islam-makhachev-275aca",      weightClass: "welterweight", startDate: "2025-11-15", endDate: null,         defenses: 0 },
  { slug: "jack-della-maddalena-6b453b", weightClass: "welterweight", startDate: "2025-05-10", endDate: "2025-11-15", defenses: 0 },
  { slug: "belal-muhammad-b1b072",       weightClass: "welterweight", startDate: "2024-07-27", endDate: "2025-05-10", defenses: 0 },
  { slug: "leon-edwards-f1fac9",         weightClass: "welterweight", startDate: "2022-08-20", endDate: "2024-07-27", defenses: 2 }, // Usman 3, Covington
  { slug: "colby-covington-dc9572",      weightClass: "welterweight", startDate: "2018-06-09", endDate: "2018-09-08", defenses: 0, isInterim: true, endReason: "stripped" }, // UFC 225 vs RDA; stripped (sinus surgery)
  { slug: "kamaru-usman-f1b2aa",         weightClass: "welterweight", startDate: "2019-03-02", endDate: "2022-08-20", defenses: 5 }, // Covington 1, Burns, Masvidal 1, Masvidal 2, Covington 2
  { slug: "tyron-woodley-effd9d",        weightClass: "welterweight", startDate: "2016-07-30", endDate: "2019-03-02", defenses: 4 }, // Wonderboy 1, Wonderboy 2, Maia, Till
  { slug: "robbie-lawler-f2925e",        weightClass: "welterweight", startDate: "2014-12-06", endDate: "2016-07-30", defenses: 2 }, // MacDonald, Condit
  { slug: "johny-hendricks-0941df",      weightClass: "welterweight", startDate: "2014-03-15", endDate: "2014-12-06", defenses: 0 },
  { slug: "carlos-condit-f9f07b",        weightClass: "welterweight", startDate: "2012-02-04", endDate: "2012-11-17", defenses: 0, isInterim: true }, // UFC 143 vs Nick Diaz; lost unification vs GSP at UFC 154
  { slug: "georges-st-pierre-6506c1",    weightClass: "welterweight", startDate: "2008-04-19", endDate: "2013-12-13", defenses: 9 }, // WW reign 2 — Fitch, Penn 2, Alves, Hardy, Koscheck 2, Shields, Diaz, Condit, Hendricks
  { slug: "georges-st-pierre-6506c1",    weightClass: "welterweight", startDate: "2007-12-29", endDate: "2008-04-19", defenses: 0, isInterim: true }, // UFC 79 vs Hughes; became undisputed at UFC 83 (def. Serra)
  { slug: "matt-serra-86dfed",           weightClass: "welterweight", startDate: "2007-04-07", endDate: "2008-04-19", defenses: 0 },
  { slug: "georges-st-pierre-6506c1",    weightClass: "welterweight", startDate: "2006-11-18", endDate: "2007-04-07", defenses: 0 }, // WW reign 1 — lost first
  { slug: "matt-hughes-621a6c",          weightClass: "welterweight", startDate: "2004-10-22", endDate: "2006-11-18", defenses: 4 }, // WW reign 2 — Trigg 2, Riggs, Royce, BJ Penn 2
  { slug: "bj-penn-73c7cf",              weightClass: "welterweight", startDate: "2004-01-31", endDate: "2004-05-17", defenses: 0, endReason: "vacated" }, // vacated (Wave 13: corrected from 2004-09-01)
  { slug: "matt-hughes-621a6c",          weightClass: "welterweight", startDate: "2001-11-02", endDate: "2004-01-31", defenses: 5 }, // WW reign 1 — Sakurai, Newton 2, Castillo, Sherk, Trigg 1
  { slug: "carlos-newton-952f6f",        weightClass: "welterweight", startDate: "2001-05-04", endDate: "2001-11-02", defenses: 0 },
  { slug: "pat-miletich-cedfdf",         weightClass: "welterweight", startDate: "1998-10-16", endDate: "2001-05-04", defenses: 4 }, // Mezger, Vlasenko, Henderson, Alessio

  // ============================================================
  // LIGHTWEIGHT
  // ============================================================
  { slug: "justin-gaethje-9e8f6c", weightClass: "lightweight", startDate: "2026-06-14", endDate: null, defenses: 0 }, // AUTO(reconcile 2026-07-02): beat Ilia Topuria
  { slug: "ilia-topuria-54f64b",          weightClass: "lightweight", startDate: "2025-06-28", endDate: "2026-06-14",         defenses: 0 }, // lost unification vs Gaethje — AUTO(reconcile 2026-07-02)
  { slug: "islam-makhachev-275aca",       weightClass: "lightweight", startDate: "2022-10-22", endDate: "2025-05-13", defenses: 4, endReason: "vacated" }, // Volkanovski 1, Volkanovski 2, Poirier, Moicano; vacated to WW (Dana White announcement)
  { slug: "charles-oliveira-07225b",      weightClass: "lightweight", startDate: "2021-05-15", endDate: "2022-05-06", defenses: 1, endReason: "stripped" }, // Poirier — stripped at weigh-ins
  { slug: "khabib-nurmagomedov-032cc3",   weightClass: "lightweight", startDate: "2018-04-07", endDate: "2021-03-19", defenses: 3, endReason: "retired" }, // Conor, Poirier, Gaethje; retired holding the belt
  { slug: "conor-mcgregor-f4c499",        weightClass: "lightweight", startDate: "2016-11-12", endDate: "2018-04-07", defenses: 0, endReason: "stripped" }, // stripped (inactivity)
  { slug: "eddie-alvarez-33a331",         weightClass: "lightweight", startDate: "2016-07-07", endDate: "2016-11-12", defenses: 0 },
  { slug: "rafael-dos-anjos-6a2f7c",      weightClass: "lightweight", startDate: "2015-03-14", endDate: "2016-07-07", defenses: 1 }, // Cerrone
  { slug: "anthony-pettis-cbb682",        weightClass: "lightweight", startDate: "2013-08-31", endDate: "2015-03-14", defenses: 1 }, // Melendez
  { slug: "benson-henderson-2676b2",      weightClass: "lightweight", startDate: "2012-02-26", endDate: "2013-08-31", defenses: 3 }, // Edgar 2, Nate Diaz, Melendez
  { slug: "frankie-edgar-f26884",         weightClass: "lightweight", startDate: "2010-04-10", endDate: "2012-02-26", defenses: 2 }, // BJ 2, Maynard 3 (Maynard 2 was a draw)
  { slug: "bj-penn-73c7cf",               weightClass: "lightweight", startDate: "2008-01-19", endDate: "2010-04-10", defenses: 3 }, // Sherk, Florian, Diego Sanchez
  { slug: "sean-sherk-029880",            weightClass: "lightweight", startDate: "2006-10-14", endDate: "2007-12-12", defenses: 1, endReason: "stripped" }, // Florian (then stripped for PED)
  { slug: "jens-pulver-442601",           weightClass: "lightweight", startDate: "2001-02-23", endDate: "2002-04-01", defenses: 2, endReason: "vacated" }, // Uno, BJ Penn (draw retained); vacated

  // Interim LW belts that never converted to undisputed
  { slug: "justin-gaethje-9e8f6c",        weightClass: "lightweight", startDate: "2026-01-24", endDate: "2026-06-14",         defenses: 0, isInterim: true }, // UFC 324 vs Pimblett; unified vs Topuria 2026-06-14 — AUTO(reconcile 2026-07-02)
  { slug: "justin-gaethje-9e8f6c",        weightClass: "lightweight", startDate: "2020-05-09", endDate: "2020-10-24", defenses: 0, isInterim: true }, // UFC 249 vs Ferguson; lost unification vs Khabib at UFC 254
  { slug: "dustin-poirier-029eaf",        weightClass: "lightweight", startDate: "2019-04-13", endDate: "2019-09-07", defenses: 0, isInterim: true }, // UFC 236 vs Holloway; lost unification vs Khabib at UFC 242
  { slug: "tony-ferguson-22a92d",         weightClass: "lightweight", startDate: "2017-10-07", endDate: "2018-04-07", defenses: 0, isInterim: true, endReason: "stripped" }, // UFC 216; stripped (injury)

  // ============================================================
  // FEATHERWEIGHT
  // ============================================================
  { slug: "alexander-volkanovski-e12489", weightClass: "featherweight", startDate: "2025-04-12", endDate: null,         defenses: 1 }, // reign 2 — Lopes 2
  { slug: "ilia-topuria-54f64b",          weightClass: "featherweight", startDate: "2024-02-17", endDate: "2025-02-19", defenses: 1, endReason: "vacated" }, // Holloway; vacated to LW (announcement)
  { slug: "yair-rodriguez-cbf5e6",        weightClass: "featherweight", startDate: "2023-02-12", endDate: "2023-07-08", defenses: 0, isInterim: true }, // UFC 284 vs Emmett; lost unification vs Volk at UFC 290
  { slug: "alexander-volkanovski-e12489", weightClass: "featherweight", startDate: "2019-12-14", endDate: "2024-02-17", defenses: 4 }, // reign 1 — Holloway 2, Ortega, Korean Zombie, Rodriguez
  { slug: "max-holloway-150ff4",          weightClass: "featherweight", startDate: "2017-06-03", endDate: "2019-12-14", defenses: 2 }, // Aldo 3, Ortega
  { slug: "max-holloway-150ff4",          weightClass: "featherweight", startDate: "2016-12-10", endDate: "2017-06-03", defenses: 0, isInterim: true }, // UFC 206 vs Pettis; unified at UFC 212 (def. Aldo)
  { slug: "jose-aldo-d0f395",             weightClass: "featherweight", startDate: "2016-07-09", endDate: "2016-11-26", defenses: 0, isInterim: true }, // UFC 200 vs Edgar 2; promoted when Conor stripped
  { slug: "conor-mcgregor-f4c499",        weightClass: "featherweight", startDate: "2015-12-12", endDate: "2016-11-26", defenses: 0, endReason: "stripped" }, // stripped after winning LW
  { slug: "conor-mcgregor-f4c499",        weightClass: "featherweight", startDate: "2015-07-11", endDate: "2015-12-12", defenses: 0, isInterim: true }, // UFC 189 vs Mendes; unified at UFC 194 (def. Aldo)
  { slug: "jose-aldo-d0f395",             weightClass: "featherweight", startDate: "2010-11-20", endDate: "2015-12-12", defenses: 7 }, // WEC→UFC merger; Hominick, Florian, Mendes 1, Edgar 1, Korean Zombie, Lamas, Mendes 2

  // ============================================================
  // BANTAMWEIGHT
  // ============================================================
  { slug: "petr-yan-d661ce",          weightClass: "bantamweight", startDate: "2025-12-06", endDate: null,         defenses: 0 }, // reign 2 — beat Merab at UFC 323
  { slug: "merab-dvalishvili-c03520", weightClass: "bantamweight", startDate: "2024-09-14", endDate: "2025-12-06", defenses: 3 }, // Umar, O'Malley 2, Sandhagen
  { slug: "sean-o-malley-b50a42",     weightClass: "bantamweight", startDate: "2023-08-19", endDate: "2024-09-14", defenses: 1 }, // Vera 2
  { slug: "aljamain-sterling-cb696e", weightClass: "bantamweight", startDate: "2021-03-06", endDate: "2023-08-19", defenses: 3 }, // Yan 2, Cejudo, Dillashaw
  { slug: "petr-yan-d661ce",          weightClass: "bantamweight", startDate: "2021-10-30", endDate: "2022-04-09", defenses: 0, isInterim: true }, // UFC 267 vs Sandhagen; lost unification vs Sterling at UFC 273
  { slug: "petr-yan-d661ce",          weightClass: "bantamweight", startDate: "2020-07-11", endDate: "2021-03-06", defenses: 0 }, // undisputed reign 1 — DQ loss first defense
  { slug: "henry-cejudo-056c49",      weightClass: "bantamweight", startDate: "2019-06-08", endDate: "2020-05-24", defenses: 1, endReason: "vacated" }, // Cruz; vacated (initial retirement) (Wave 13: corrected from 2020-05-19)
  { slug: "tj-dillashaw-c84974",      weightClass: "bantamweight", startDate: "2017-11-04", endDate: "2019-03-20", defenses: 1, endReason: "stripped" }, // Garbrandt 2; stripped PED
  { slug: "cody-garbrandt-d8c7c6",    weightClass: "bantamweight", startDate: "2016-12-30", endDate: "2017-11-04", defenses: 0 },
  { slug: "dominick-cruz-10f3ba",     weightClass: "bantamweight", startDate: "2016-01-17", endDate: "2016-12-30", defenses: 1 }, // reign 2 — Faber 4
  { slug: "tj-dillashaw-c84974",      weightClass: "bantamweight", startDate: "2014-05-24", endDate: "2016-01-17", defenses: 1 }, // reign 1 — Soto
  { slug: "renan-barao-2c9957",       weightClass: "bantamweight", startDate: "2014-01-06", endDate: "2014-05-24", defenses: 1 }, // undisputed — promoted when Cruz vacated; Faber 3
  { slug: "renan-barao-2c9957",       weightClass: "bantamweight", startDate: "2012-07-21", endDate: "2014-01-06", defenses: 0, isInterim: true }, // UFC 149 vs Faber 2; promoted when Cruz vacated (injury)
  { slug: "dominick-cruz-10f3ba",     weightClass: "bantamweight", startDate: "2010-12-16", endDate: "2014-01-06", defenses: 3, endReason: "vacated" }, // reign 1 — Benavidez 2, DJ, Faber 2; vacated injury

  // ============================================================
  // FLYWEIGHT
  // ============================================================
  { slug: "joshua-van-17e976",         weightClass: "flyweight", startDate: "2025-12-06", endDate: null,         defenses: 1 }, // beat Pantoja at UFC 323; def. Taira
  { slug: "alexandre-pantoja-a0f000",  weightClass: "flyweight", startDate: "2023-07-08", endDate: "2025-12-06", defenses: 4 }, // Royval 2, Erceg, Asakura, Kape
  { slug: "brandon-moreno-792be9",     weightClass: "flyweight", startDate: "2023-01-21", endDate: "2023-07-08", defenses: 0 }, // reign 3 undisputed — unified vs Figueiredo at UFC 283
  { slug: "brandon-moreno-792be9",     weightClass: "flyweight", startDate: "2022-07-30", endDate: "2023-01-21", defenses: 0, isInterim: true }, // UFC 277 vs Kara-France; unified at UFC 283 (def. Figueiredo)
  { slug: "deiveson-figueiredo-aa72b0", weightClass: "flyweight", startDate: "2022-01-22", endDate: "2023-01-21", defenses: 0 }, // reign 2 — lost rematch immediately
  { slug: "brandon-moreno-792be9",     weightClass: "flyweight", startDate: "2021-06-12", endDate: "2022-01-22", defenses: 0 }, // reign 1
  { slug: "deiveson-figueiredo-aa72b0", weightClass: "flyweight", startDate: "2020-07-18", endDate: "2021-06-12", defenses: 1 }, // reign 1 — Perez; Moreno draw retained
  { slug: "henry-cejudo-056c49",       weightClass: "flyweight", startDate: "2018-08-04", endDate: "2019-12-20", defenses: 1, endReason: "vacated" }, // Dillashaw; vacated to focus on BW (Wave 13: corrected from 2019-12-15)
  { slug: "demetrious-johnson-8a304b", weightClass: "flyweight", startDate: "2012-09-22", endDate: "2018-08-04", defenses: 11 }, // historic — Dodson, Moraes, Benavidez 2, Bagautinov, Cariaso, Horiguchi, Dodson 2, Cejudo 1, Elliott, Reis, Borg

  // ============================================================
  // WOMEN'S BANTAMWEIGHT (uses bantamweight enum)
  // ============================================================
  { slug: "kayla-harrison-1af117",     weightClass: "bantamweight", startDate: "2025-06-07", endDate: null,         defenses: 0 }, // beat Pena at UFC 316
  { slug: "julianna-pena-3253b1",      weightClass: "bantamweight", startDate: "2024-10-05", endDate: "2025-06-07", defenses: 0 }, // reign 2
  { slug: "raquel-pennington-fc169c",  weightClass: "bantamweight", startDate: "2024-01-20", endDate: "2024-10-05", defenses: 0 },
  { slug: "amanda-nunes-80fa82",       weightClass: "bantamweight", startDate: "2022-07-30", endDate: "2023-06-10", defenses: 1, endReason: "retired" }, // reign 2 — Aldana; retired
  { slug: "julianna-pena-3253b1",      weightClass: "bantamweight", startDate: "2021-12-11", endDate: "2022-07-30", defenses: 0 }, // reign 1
  { slug: "amanda-nunes-80fa82",       weightClass: "bantamweight", startDate: "2016-07-09", endDate: "2021-12-11", defenses: 6 }, // reign 1 — Rousey, Shevchenko 2, Pennington 1, Holm, de Randamie, Spencer
  { slug: "miesha-tate-b96619",        weightClass: "bantamweight", startDate: "2016-03-05", endDate: "2016-07-09", defenses: 0 },
  { slug: "holly-holm-634e2f",         weightClass: "bantamweight", startDate: "2015-11-15", endDate: "2016-03-05", defenses: 0 },
  { slug: "ronda-rousey-8bdac2",       weightClass: "bantamweight", startDate: "2013-02-23", endDate: "2015-11-15", defenses: 6 }, // Carmouche, Tate, McMann, Davis, Zingano, Correia

  // ============================================================
  // WOMEN'S FEATHERWEIGHT (defunct — uses featherweight enum)
  // ============================================================
  { slug: "amanda-nunes-80fa82",        weightClass: "featherweight", startDate: "2018-12-29", endDate: "2023-06-10", defenses: 2, endReason: "retired" }, // two-belt era — Anderson, Spencer
  { slug: "cristiane-justino-634bb0",   weightClass: "featherweight", startDate: "2017-07-29", endDate: "2018-12-29", defenses: 2 }, // Holm, Kunitskaya
  { slug: "germaine-de-randamie-1d239d", weightClass: "featherweight", startDate: "2017-02-11", endDate: "2017-06-08", defenses: 0, endReason: "stripped" }, // stripped

  // ============================================================
  // WOMEN'S FLYWEIGHT (uses flyweight enum)
  // ============================================================
  { slug: "valentina-shevchenko-132deb", weightClass: "flyweight", startDate: "2024-09-14", endDate: null,         defenses: 2 }, // reign 2 — Fiorot, Zhang
  { slug: "alexa-grasso-e8b731",         weightClass: "flyweight", startDate: "2023-03-04", endDate: "2024-09-14", defenses: 0 }, // Shev 2 draw retained but lost trilogy
  { slug: "valentina-shevchenko-132deb", weightClass: "flyweight", startDate: "2018-12-08", endDate: "2023-03-04", defenses: 7 }, // reign 1 — Eye, Carmouche 2, Maia, Cerminara, Andrade, Murphy, Santos
  { slug: "nicco-montano-1de9ad",        weightClass: "flyweight", startDate: "2017-12-01", endDate: "2018-09-08", defenses: 0, endReason: "stripped" }, // stripped (weight)

  // ============================================================
  // WOMEN'S STRAWWEIGHT (uses strawweight enum)
  // ============================================================
  { slug: "mackenzie-dern-7447e9",     weightClass: "strawweight", startDate: "2025-10-25", endDate: null,         defenses: 0 }, // won vacant title vs Jandiroba at UFC 321
  { slug: "zhang-weili-1ebe20",        weightClass: "strawweight", startDate: "2022-11-12", endDate: "2025-08-28", defenses: 3, endReason: "vacated" }, // reign 2 — Lemos, Yan Xiaonan, Suarez; vacated 2025-08-28 to move to FlyW (Wave 13: corrected from Dern-win date 2025-10-25)
  { slug: "carla-esparza-d91066",      weightClass: "strawweight", startDate: "2022-05-07", endDate: "2022-11-12", defenses: 0 }, // reign 2
  { slug: "rose-namajunas-47b632",     weightClass: "strawweight", startDate: "2021-04-24", endDate: "2022-05-07", defenses: 1 }, // reign 2 — Zhang 2
  { slug: "zhang-weili-1ebe20",        weightClass: "strawweight", startDate: "2019-08-31", endDate: "2021-04-24", defenses: 1 }, // reign 1 — Joanna 1
  { slug: "jessica-andrade-6a1901",    weightClass: "strawweight", startDate: "2019-05-11", endDate: "2019-08-31", defenses: 0 },
  { slug: "rose-namajunas-47b632",     weightClass: "strawweight", startDate: "2017-11-04", endDate: "2019-05-11", defenses: 1 }, // reign 1 — Joanna 2
  { slug: "joanna-jedrzejczyk-3d6749", weightClass: "strawweight", startDate: "2015-03-14", endDate: "2017-11-04", defenses: 5 }, // Penne, Letourneau, Gadelha, Kowalkiewicz, Rose 1
  { slug: "carla-esparza-d91066",      weightClass: "strawweight", startDate: "2014-12-12", endDate: "2015-03-14", defenses: 0 }, // reign 1 (inaugural)
];

// ===== Helpers =====

const REIGNS_BY_SLUG: ReadonlyMap<string, ChampionshipReign[]> = (() => {
  const m = new Map<string, ChampionshipReign[]>();
  for (const r of CHAMPIONSHIP_HISTORY) {
    const cur = m.get(r.slug) ?? [];
    cur.push(r);
    m.set(r.slug, cur);
  }
  return m;
})();

export function getChampionshipReigns(slug: string): ChampionshipReign[] {
  return REIGNS_BY_SLUG.get(slug) ?? [];
}

/** True iff the fighter holds at least one current reign (endDate === null). */
export function isCurrentChampion(slug: string): boolean {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return false;
  return reigns.some((r) => r.endDate === null);
}

/** Alias for clarity in the tier classifier. */
export const isActiveChampion = isCurrentChampion;

/** True iff the fighter ever held a UFC belt (any reign, regardless of end). */
export function isFormerChampion(slug: string): boolean {
  return REIGNS_BY_SLUG.has(slug);
}

/** True iff the fighter held UFC titles but every reign was interim.
 *  Wave 10B uses this to cap CP at 70 instead of the undisputed-former 80. */
export function hasOnlyInterimReigns(slug: string): boolean {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns || reigns.length === 0) return false;
  return reigns.every((r) => r.isInterim === true);
}

/** Distinct undisputed weight classes the fighter has held a UFC title in.
 *  Interim reigns are excluded — "double champion" historically means two
 *  undisputed belts. */
export function championshipDivisions(slug: string): WeightClass[] {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return [];
  const divisions = new Set<WeightClass>();
  for (const r of reigns) {
    if (!r.isInterim) divisions.add(r.weightClass);
  }
  return Array.from(divisions);
}

/** True iff the fighter held undisputed UFC titles in 2+ weight classes
 *  (Conor, DC, Cejudo, Nunes, Jones, Islam, BJ Penn, Couture, GSP). */
export function isDoubleChampion(slug: string): boolean {
  return championshipDivisions(slug).length >= 2;
}

/** Successful title defenses summed across all undisputed reigns. Interim
 *  reigns are excluded. */
export function totalDefenses(slug: string): number {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return 0;
  let total = 0;
  for (const r of reigns) {
    if (!r.isInterim) total += r.defenses;
  }
  return total;
}

/** "Dominant champion" per Wave 3.5 step 4A — 3+ total defenses across all
 *  undisputed reigns. Captures Anderson (10), DJ (11), Jones (12 across two
 *  divisions), GSP (9 in WW reign 2), Volk, Aldo, Khabib, Islam, Rousey,
 *  Nunes, Joanna, Shevchenko — without including one-and-done champions. */
export function isDominantChampion(slug: string): boolean {
  return totalDefenses(slug) >= 3;
}

/**
 * Wave 6E.2 — most recent CLOSED reign for the fighter (by endDate), or null
 * when the fighter is currently champion or never held a belt. Used by the CP
 * computation to decide whether the "sticky 100" rule applies based on the
 * reign's `endReason` and the fighter's next-bout date.
 */
export function mostRecentClosedReign(slug: string): ChampionshipReign | null {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return null;
  let pick: ChampionshipReign | null = null;
  for (const r of reigns) {
    if (r.endDate == null) continue;
    if (pick == null || r.endDate > pick.endDate!) pick = r;
  }
  return pick;
}

/** Sum of days across every recorded reign for the fighter. Open-ended reigns
 *  use today as their effective end date. */
export function totalDaysAsChampion(slug: string): number {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return 0;
  const now = Date.now();
  let total = 0;
  for (const r of reigns) {
    const start = new Date(r.startDate).getTime();
    const end = r.endDate ? new Date(r.endDate).getTime() : now;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      total += Math.floor((end - start) / 86_400_000);
    }
  }
  return total;
}
