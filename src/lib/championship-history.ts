/**
 * Curated UFC championship history.
 *
 * Why this exists: the source data has no notion of "did a fighter ever hold a
 * UFC belt." We need it for the Vertex Score's Championship Pedigree
 * component. The list below is built from researched UFC title history and
 * intersected with fighter slugs that actually exist in our DB — fighters not
 * in the DB are silently skipped.
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
 * Coverage target (Wave 3.5 step 1): ~100 reigns covering the modern era
 * (2010+) for every active division + legendary champs (Anderson, GSP, BJ,
 * Hughes, Liddell, DC, etc.). Pre-2005 obscure reigns are deliberately
 * skipped — not worth the research-vs-impact ratio at this stage.
 *
 * TODO Wave 3.5+: expand to include all UFC champions back to 1994 (Royce
 * Gracie, Ken Shamrock, Mark Coleman early reigns, etc.) once we have a more
 * complete photo + roster scrape of those eras.
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
  /** True for interim-title reigns that were not later promoted to undisputed. */
  isInterim?: boolean;
}

export const CHAMPIONSHIP_HISTORY: readonly ChampionshipReign[] = [
  // ============================================================
  // HEAVYWEIGHT
  // ============================================================
  { slug: "tom-aspinall-399afb",     weightClass: "heavyweight", startDate: "2025-10-25", endDate: null },
  { slug: "tom-aspinall-399afb",     weightClass: "heavyweight", startDate: "2023-11-11", endDate: "2025-10-25", isInterim: true }, // interim, then unified at 321
  { slug: "jon-jones-07f72a",        weightClass: "heavyweight", startDate: "2023-03-04", endDate: "2025-06-21" }, // vacated/retired
  { slug: "francis-ngannou-8d03ce",  weightClass: "heavyweight", startDate: "2021-03-27", endDate: "2023-01-14" }, // vacated
  { slug: "stipe-miocic-d28dee",     weightClass: "heavyweight", startDate: "2019-08-17", endDate: "2021-03-27" }, // reign 2
  { slug: "daniel-cormier-d967f0",   weightClass: "heavyweight", startDate: "2018-07-07", endDate: "2019-08-17" },
  { slug: "stipe-miocic-d28dee",     weightClass: "heavyweight", startDate: "2016-05-14", endDate: "2018-07-07" }, // reign 1
  { slug: "fabricio-werdum-492b20",  weightClass: "heavyweight", startDate: "2015-06-13", endDate: "2016-05-14" },
  { slug: "cain-velasquez-0ff11c",   weightClass: "heavyweight", startDate: "2012-12-29", endDate: "2015-06-13" }, // reign 2
  { slug: "junior-dos-santos-63def5", weightClass: "heavyweight", startDate: "2011-11-12", endDate: "2012-12-29" },
  { slug: "cain-velasquez-0ff11c",   weightClass: "heavyweight", startDate: "2010-10-23", endDate: "2011-11-12" }, // reign 1
  { slug: "brock-lesnar-513c6f",     weightClass: "heavyweight", startDate: "2008-11-15", endDate: "2010-10-23" },
  { slug: "randy-couture-0aa925",    weightClass: "heavyweight", startDate: "2007-03-03", endDate: "2008-11-15" }, // last HW reign
  { slug: "tim-sylvia-2a542e",       weightClass: "heavyweight", startDate: "2006-04-15", endDate: "2007-03-03" },
  { slug: "andrei-arlovski-3738e6",  weightClass: "heavyweight", startDate: "2005-02-05", endDate: "2006-04-15" }, // interim then unified
  { slug: "frank-mir-1ff958",        weightClass: "heavyweight", startDate: "2004-06-19", endDate: "2005-02-05" }, // stripped (motorcycle injury)
  { slug: "ricco-rodriguez-50cc91",  weightClass: "heavyweight", startDate: "2002-09-27", endDate: "2003-02-28" },
  { slug: "kevin-randleman-6859f6",  weightClass: "heavyweight", startDate: "1999-11-19", endDate: "2000-11-17" },
  { slug: "bas-rutten-03688d",       weightClass: "heavyweight", startDate: "1999-05-07", endDate: "1999-08-01" }, // vacated
  { slug: "maurice-smith-33e33d",    weightClass: "heavyweight", startDate: "1997-07-27", endDate: "1997-12-21" },
  { slug: "mark-coleman-21b8a0",     weightClass: "heavyweight", startDate: "1997-02-07", endDate: "1997-07-27" },

  // ============================================================
  // LIGHT HEAVYWEIGHT
  // ============================================================
  { slug: "alex-pereira-e5549c",       weightClass: "light_heavyweight", startDate: "2025-10-04", endDate: null }, // reign 2
  { slug: "magomed-ankalaev-d80217",   weightClass: "light_heavyweight", startDate: "2025-03-08", endDate: "2025-10-04" },
  { slug: "alex-pereira-e5549c",       weightClass: "light_heavyweight", startDate: "2023-11-11", endDate: "2025-03-08" }, // reign 1
  { slug: "jamahal-hill-5444c5",       weightClass: "light_heavyweight", startDate: "2023-01-21", endDate: "2023-07-01" }, // vacated (injury)
  { slug: "jiri-prochazka-009341",     weightClass: "light_heavyweight", startDate: "2022-06-11", endDate: "2022-11-23" }, // vacated (injury)
  { slug: "glover-teixeira-7ff978",    weightClass: "light_heavyweight", startDate: "2021-10-30", endDate: "2022-06-11" },
  { slug: "jan-blachowicz-99df7d",     weightClass: "light_heavyweight", startDate: "2020-09-26", endDate: "2021-10-30" },
  { slug: "jon-jones-07f72a",          weightClass: "light_heavyweight", startDate: "2018-12-29", endDate: "2020-08-17" }, // reign 2, vacated to HW
  { slug: "daniel-cormier-d967f0",     weightClass: "light_heavyweight", startDate: "2015-05-23", endDate: "2018-12-29" }, // gap covers his reinstatement
  { slug: "jon-jones-07f72a",          weightClass: "light_heavyweight", startDate: "2011-03-19", endDate: "2015-04-28" }, // reign 1, stripped
  { slug: "mauricio-rua-140745",       weightClass: "light_heavyweight", startDate: "2010-05-08", endDate: "2011-03-19" },
  { slug: "lyoto-machida-f7a7f7",      weightClass: "light_heavyweight", startDate: "2009-05-23", endDate: "2010-05-08" },
  { slug: "rashad-evans-ee779c",       weightClass: "light_heavyweight", startDate: "2008-12-27", endDate: "2009-05-23" },
  { slug: "forrest-griffin-fcffee",    weightClass: "light_heavyweight", startDate: "2008-07-05", endDate: "2008-12-27" },
  { slug: "quinton-jackson-ffc088",    weightClass: "light_heavyweight", startDate: "2007-05-26", endDate: "2008-07-05" },
  { slug: "chuck-liddell-a390eb",      weightClass: "light_heavyweight", startDate: "2005-04-16", endDate: "2007-05-26" },
  { slug: "randy-couture-0aa925",      weightClass: "light_heavyweight", startDate: "2004-08-21", endDate: "2005-04-16" }, // LHW reign 2
  { slug: "vitor-belfort-0ee783",      weightClass: "light_heavyweight", startDate: "2004-01-31", endDate: "2004-08-21" },
  { slug: "randy-couture-0aa925",      weightClass: "light_heavyweight", startDate: "2003-06-06", endDate: "2004-01-31" }, // LHW reign 1
  { slug: "tito-ortiz-2f732d",         weightClass: "light_heavyweight", startDate: "2000-04-14", endDate: "2003-09-26" },

  // ============================================================
  // MIDDLEWEIGHT
  // ============================================================
  { slug: "khamzat-chimaev-767755",   weightClass: "middleweight", startDate: "2025-08-16", endDate: null },
  { slug: "dricus-du-plessis-0d7b51", weightClass: "middleweight", startDate: "2024-01-20", endDate: "2025-08-16" },
  { slug: "sean-strickland-0d8011",   weightClass: "middleweight", startDate: "2023-09-09", endDate: "2024-01-20" },
  { slug: "israel-adesanya-1338e2",   weightClass: "middleweight", startDate: "2023-04-08", endDate: "2023-09-09" }, // reign 2
  { slug: "alex-pereira-e5549c",      weightClass: "middleweight", startDate: "2022-11-12", endDate: "2023-04-08" },
  { slug: "israel-adesanya-1338e2",   weightClass: "middleweight", startDate: "2019-10-05", endDate: "2022-11-12" }, // reign 1 (interim → undisputed)
  { slug: "robert-whittaker-e1147d",  weightClass: "middleweight", startDate: "2017-07-08", endDate: "2019-10-05" },
  { slug: "georges-st-pierre-6506c1", weightClass: "middleweight", startDate: "2017-11-04", endDate: "2017-12-07" }, // won, vacated
  { slug: "michael-bisping-2b93eb",   weightClass: "middleweight", startDate: "2016-06-04", endDate: "2017-11-04" },
  { slug: "luke-rockhold-00e11b",     weightClass: "middleweight", startDate: "2015-12-12", endDate: "2016-06-04" },
  { slug: "chris-weidman-3a8176",     weightClass: "middleweight", startDate: "2013-07-06", endDate: "2015-12-12" },
  { slug: "anderson-silva-1f4543",    weightClass: "middleweight", startDate: "2006-10-14", endDate: "2013-07-06" }, // historic 7-year reign
  { slug: "rich-franklin-d89789",     weightClass: "middleweight", startDate: "2005-06-04", endDate: "2006-10-14" },
  { slug: "evan-tanner-8f2d9e",       weightClass: "middleweight", startDate: "2005-02-05", endDate: "2005-06-04" },
  { slug: "murilo-bustamante-85d905", weightClass: "middleweight", startDate: "2002-01-11", endDate: "2002-08-22" }, // stripped

  // ============================================================
  // WELTERWEIGHT
  // ============================================================
  { slug: "islam-makhachev-275aca",      weightClass: "welterweight", startDate: "2025-11-15", endDate: null },
  { slug: "jack-della-maddalena-6b453b", weightClass: "welterweight", startDate: "2025-05-10", endDate: "2025-11-15" },
  { slug: "belal-muhammad-b1b072",       weightClass: "welterweight", startDate: "2024-07-27", endDate: "2025-05-10" },
  { slug: "leon-edwards-f1fac9",         weightClass: "welterweight", startDate: "2022-08-20", endDate: "2024-07-27" },
  { slug: "kamaru-usman-f1b2aa",         weightClass: "welterweight", startDate: "2019-03-02", endDate: "2022-08-20" },
  { slug: "tyron-woodley-effd9d",        weightClass: "welterweight", startDate: "2016-07-30", endDate: "2019-03-02" },
  { slug: "robbie-lawler-f2925e",        weightClass: "welterweight", startDate: "2014-12-06", endDate: "2016-07-30" },
  { slug: "johny-hendricks-0941df",      weightClass: "welterweight", startDate: "2014-03-15", endDate: "2014-12-06" },
  { slug: "georges-st-pierre-6506c1",    weightClass: "welterweight", startDate: "2008-04-19", endDate: "2013-12-13" }, // WW reign 2
  { slug: "matt-serra-86dfed",           weightClass: "welterweight", startDate: "2007-04-07", endDate: "2008-04-19" },
  { slug: "georges-st-pierre-6506c1",    weightClass: "welterweight", startDate: "2006-11-18", endDate: "2007-04-07" }, // WW reign 1
  { slug: "matt-hughes-621a6c",          weightClass: "welterweight", startDate: "2004-10-22", endDate: "2006-11-18" }, // WW reign 2
  { slug: "bj-penn-73c7cf",              weightClass: "welterweight", startDate: "2004-01-31", endDate: "2004-09-01" }, // vacated
  { slug: "matt-hughes-621a6c",          weightClass: "welterweight", startDate: "2001-11-02", endDate: "2004-01-31" }, // WW reign 1
  { slug: "carlos-newton-952f6f",        weightClass: "welterweight", startDate: "2001-05-04", endDate: "2001-11-02" },
  { slug: "pat-miletich-cedfdf",         weightClass: "welterweight", startDate: "1998-10-16", endDate: "2001-05-04" },

  // ============================================================
  // LIGHTWEIGHT
  // ============================================================
  { slug: "ilia-topuria-54f64b",          weightClass: "lightweight", startDate: "2025-06-28", endDate: null },
  { slug: "islam-makhachev-275aca",       weightClass: "lightweight", startDate: "2022-10-22", endDate: "2025-02-21" }, // vacated to WW
  { slug: "charles-oliveira-07225b",      weightClass: "lightweight", startDate: "2021-05-15", endDate: "2022-05-06" }, // stripped (weight)
  { slug: "khabib-nurmagomedov-032cc3",   weightClass: "lightweight", startDate: "2018-04-07", endDate: "2021-03-19" }, // retired/vacated
  { slug: "conor-mcgregor-f4c499",        weightClass: "lightweight", startDate: "2016-11-12", endDate: "2018-04-07" }, // stripped
  { slug: "eddie-alvarez-33a331",         weightClass: "lightweight", startDate: "2016-07-07", endDate: "2016-11-12" },
  { slug: "rafael-dos-anjos-6a2f7c",      weightClass: "lightweight", startDate: "2015-03-14", endDate: "2016-07-07" },
  { slug: "anthony-pettis-cbb682",        weightClass: "lightweight", startDate: "2013-08-31", endDate: "2015-03-14" },
  { slug: "benson-henderson-2676b2",      weightClass: "lightweight", startDate: "2012-02-26", endDate: "2013-08-31" },
  { slug: "frankie-edgar-f26884",         weightClass: "lightweight", startDate: "2010-04-10", endDate: "2012-02-26" },
  { slug: "bj-penn-73c7cf",               weightClass: "lightweight", startDate: "2008-01-19", endDate: "2010-04-10" },
  { slug: "sean-sherk-029880",            weightClass: "lightweight", startDate: "2006-10-14", endDate: "2007-12-12" }, // stripped (PED)
  { slug: "jens-pulver-442601",           weightClass: "lightweight", startDate: "2001-02-23", endDate: "2002-04-01" }, // vacated

  // Interim LW belts that never converted to undisputed
  { slug: "justin-gaethje-9e8f6c",        weightClass: "lightweight", startDate: "2020-05-09", endDate: "2020-10-24", isInterim: true },
  { slug: "dustin-poirier-029eaf",        weightClass: "lightweight", startDate: "2019-04-13", endDate: "2019-09-07", isInterim: true },
  { slug: "tony-ferguson-22a92d",         weightClass: "lightweight", startDate: "2017-10-07", endDate: "2018-04-07", isInterim: true }, // stripped (injury)

  // ============================================================
  // FEATHERWEIGHT
  // ============================================================
  { slug: "alexander-volkanovski-e12489", weightClass: "featherweight", startDate: "2025-04-12", endDate: null }, // reign 2 (vacant)
  { slug: "ilia-topuria-54f64b",          weightClass: "featherweight", startDate: "2024-02-17", endDate: "2025-02-21" }, // vacated to LW
  { slug: "alexander-volkanovski-e12489", weightClass: "featherweight", startDate: "2019-12-14", endDate: "2024-02-17" }, // reign 1
  { slug: "max-holloway-150ff4",          weightClass: "featherweight", startDate: "2017-06-03", endDate: "2019-12-14" },
  { slug: "jose-aldo-d0f395",             weightClass: "featherweight", startDate: "2010-11-20", endDate: "2015-12-12" }, // WEC→UFC merger reign
  { slug: "conor-mcgregor-f4c499",        weightClass: "featherweight", startDate: "2015-12-12", endDate: "2016-11-26" }, // stripped after winning LW

  // ============================================================
  // BANTAMWEIGHT
  // ============================================================
  { slug: "merab-dvalishvili-c03520", weightClass: "bantamweight", startDate: "2024-09-14", endDate: null },
  { slug: "sean-o-malley-b50a42",     weightClass: "bantamweight", startDate: "2023-08-19", endDate: "2024-09-14" },
  { slug: "aljamain-sterling-cb696e", weightClass: "bantamweight", startDate: "2021-03-06", endDate: "2023-08-19" },
  { slug: "petr-yan-d661ce",          weightClass: "bantamweight", startDate: "2020-07-11", endDate: "2021-03-06" }, // DQ loss
  { slug: "henry-cejudo-056c49",      weightClass: "bantamweight", startDate: "2019-06-08", endDate: "2020-05-19" }, // vacated
  { slug: "tj-dillashaw-c84974",      weightClass: "bantamweight", startDate: "2017-11-04", endDate: "2019-03-20" }, // PED strip
  { slug: "cody-garbrandt-d8c7c6",    weightClass: "bantamweight", startDate: "2016-12-30", endDate: "2017-11-04" },
  { slug: "dominick-cruz-10f3ba",     weightClass: "bantamweight", startDate: "2016-01-17", endDate: "2016-12-30" }, // reign 2
  { slug: "tj-dillashaw-c84974",      weightClass: "bantamweight", startDate: "2014-05-24", endDate: "2016-01-17" }, // reign 1
  { slug: "renan-barao-2c9957",       weightClass: "bantamweight", startDate: "2012-07-21", endDate: "2014-05-24" }, // interim → undisputed when Cruz vacated
  { slug: "dominick-cruz-10f3ba",     weightClass: "bantamweight", startDate: "2010-12-16", endDate: "2014-01-06" }, // reign 1, vacated (injury)

  // ============================================================
  // FLYWEIGHT
  // ============================================================
  { slug: "alexandre-pantoja-a0f000",  weightClass: "flyweight", startDate: "2023-07-08", endDate: null },
  { slug: "brandon-moreno-792be9",     weightClass: "flyweight", startDate: "2023-01-21", endDate: "2023-07-08" }, // reign 3 (interim → undisputed)
  { slug: "deiveson-figueiredo-aa72b0", weightClass: "flyweight", startDate: "2022-01-22", endDate: "2023-01-21" }, // reign 2
  { slug: "brandon-moreno-792be9",     weightClass: "flyweight", startDate: "2021-06-12", endDate: "2022-01-22" }, // reign 1
  { slug: "deiveson-figueiredo-aa72b0", weightClass: "flyweight", startDate: "2020-07-18", endDate: "2021-06-12" }, // reign 1
  { slug: "henry-cejudo-056c49",       weightClass: "flyweight", startDate: "2018-08-04", endDate: "2019-12-15" }, // vacated to focus on BW
  { slug: "demetrious-johnson-8a304b", weightClass: "flyweight", startDate: "2012-09-22", endDate: "2018-08-04" }, // historic 11-defense reign

  // ============================================================
  // WOMEN'S BANTAMWEIGHT (uses bantamweight enum)
  // ============================================================
  { slug: "julianna-pena-3253b1",      weightClass: "bantamweight", startDate: "2024-10-05", endDate: "2025-06-07" }, // reign 2
  { slug: "raquel-pennington-fc169c",  weightClass: "bantamweight", startDate: "2024-01-20", endDate: "2024-10-05" },
  { slug: "amanda-nunes-80fa82",       weightClass: "bantamweight", startDate: "2022-07-30", endDate: "2023-06-10" }, // reign 2, retired
  { slug: "julianna-pena-3253b1",      weightClass: "bantamweight", startDate: "2021-12-11", endDate: "2022-07-30" }, // reign 1
  { slug: "amanda-nunes-80fa82",       weightClass: "bantamweight", startDate: "2016-07-09", endDate: "2021-12-11" }, // reign 1
  { slug: "miesha-tate-b96619",        weightClass: "bantamweight", startDate: "2016-03-05", endDate: "2016-07-09" },
  { slug: "holly-holm-634e2f",         weightClass: "bantamweight", startDate: "2015-11-15", endDate: "2016-03-05" },
  { slug: "ronda-rousey-8bdac2",       weightClass: "bantamweight", startDate: "2013-02-23", endDate: "2015-11-15" },

  // ============================================================
  // WOMEN'S FEATHERWEIGHT (defunct)
  // ============================================================
  { slug: "amanda-nunes-80fa82",        weightClass: "featherweight", startDate: "2018-12-29", endDate: "2023-06-10" }, // two-belt era
  { slug: "cristiane-justino-634bb0",   weightClass: "featherweight", startDate: "2017-07-29", endDate: "2018-12-29" },
  { slug: "germaine-de-randamie-1d239d", weightClass: "featherweight", startDate: "2017-02-11", endDate: "2017-06-08" }, // stripped

  // ============================================================
  // WOMEN'S FLYWEIGHT (uses flyweight enum)
  // ============================================================
  { slug: "valentina-shevchenko-132deb", weightClass: "flyweight", startDate: "2024-09-14", endDate: null }, // reign 2
  { slug: "alexa-grasso-e8b731",         weightClass: "flyweight", startDate: "2023-03-04", endDate: "2024-09-14" },
  { slug: "valentina-shevchenko-132deb", weightClass: "flyweight", startDate: "2018-12-08", endDate: "2023-03-04" }, // reign 1
  { slug: "nicco-montano-1de9ad",        weightClass: "flyweight", startDate: "2017-12-01", endDate: "2018-09-08" }, // stripped (weight)

  // ============================================================
  // WOMEN'S STRAWWEIGHT (uses strawweight enum)
  // ============================================================
  { slug: "zhang-weili-1ebe20",        weightClass: "strawweight", startDate: "2022-11-12", endDate: null }, // reign 2
  { slug: "carla-esparza-d91066",      weightClass: "strawweight", startDate: "2022-05-07", endDate: "2022-11-12" }, // reign 2
  { slug: "rose-namajunas-47b632",     weightClass: "strawweight", startDate: "2021-04-24", endDate: "2022-05-07" }, // reign 2
  { slug: "zhang-weili-1ebe20",        weightClass: "strawweight", startDate: "2019-08-31", endDate: "2021-04-24" }, // reign 1
  { slug: "jessica-andrade-6a1901",    weightClass: "strawweight", startDate: "2019-05-11", endDate: "2019-08-31" },
  { slug: "rose-namajunas-47b632",     weightClass: "strawweight", startDate: "2017-11-04", endDate: "2019-05-11" }, // reign 1
  { slug: "joanna-jedrzejczyk-3d6749", weightClass: "strawweight", startDate: "2015-03-14", endDate: "2017-11-04" },
  { slug: "carla-esparza-d91066",      weightClass: "strawweight", startDate: "2014-12-12", endDate: "2015-03-14" }, // reign 1 (inaugural)
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

/** True iff the fighter ever held a UFC belt (regardless of whether it ended). */
export function isFormerChampion(slug: string): boolean {
  return REIGNS_BY_SLUG.has(slug);
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
 *  (Conor, DC, Cejudo, Nunes, Jones, Islam, BJ Penn, Couture, GSP, Adesanya). */
export function isDoubleChampion(slug: string): boolean {
  return championshipDivisions(slug).length >= 2;
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
