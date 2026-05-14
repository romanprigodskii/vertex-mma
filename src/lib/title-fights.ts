/**
 * Curated list of bout IDs that were actual UFC title fights.
 *
 * Why this exists: `bout.is_title_fight` from our UFCStats scrape is unreliable
 * — the scraper flags entire main-card slates as "title" on cards that have a
 * title-headlined main event (e.g. UFC 311 has 4 bouts flagged, only 1 is real;
 * UFC 322 has 6 flagged, only 1 is real). Investigation in Wave 3C.1.2 confirmed
 * this: 671 of 772 events with 5+ bouts fall in the 20-49% "flagged" range,
 * indicating systematic over-flagging of the main card. See
 * `scripts/investigate_title_fights*.ts` for the queries.
 *
 * Coverage: the 12 current UFC champions' verified title fights + Khabib /
 * Conor's title bouts (the Compare page's example matchup). Each entry is one
 * bout_id; the trailing comment is the human-readable event + matchup so
 * future maintainers can audit without round-tripping through the DB.
 *
 * TODO Wave 3.5+: extend to all UFC champion title history (Adesanya, Usman,
 * Nunes, Jones, DC, GSP, Khabib's full LW title reign etc.) once we have a
 * scrape-or-import workflow that doesn't require hand-curation.
 */

const CURATED_TITLE_BOUT_IDS: readonly string[] = [
  // --- Tom Aspinall (HW) ---
  "44eba65e-3aa5-4f83-a716-8b25193e0627", // UFC 321 vs Ciryl Gane            (2025-10-25) HW title
  "69d78d34-c429-40bc-a197-baf8fac7a613", // UFC 295 vs Sergei Pavlovich      (2023-11-11) interim HW title

  // --- Alex Pereira (LHW + former MW) ---
  "a4bc2812-2ff7-441a-aff0-96bd16a954ae", // UFC 320 vs Magomed Ankalaev 2    (2025-10-04) LHW title
  "46061d6f-04eb-43a4-b34d-0a3bbed957f4", // UFC 313 vs Magomed Ankalaev      (2025-03-08) LHW title
  "efd1b690-58ed-4222-af8b-4733f67805fb", // UFC 307 vs Khalil Rountree Jr    (2024-10-05) LHW title
  "00f83584-457a-4aaa-b3e6-a96b81ae147c", // UFC 303 vs Jiri Prochazka 2      (2024-06-29) LHW title
  "aa4e5169-392e-4152-ab4d-eaaeda6af2ab", // UFC 300 vs Jamahal Hill          (2024-04-13) LHW title
  "e90ff4cb-495c-4b12-afd6-3a6a2cfc083e", // UFC 295 vs Jiri Prochazka        (2023-11-11) LHW title (vacant)
  "647e2d30-fd67-4a16-ae20-bf5869595027", // UFC 287 vs Israel Adesanya 2     (2023-04-08) MW title
  "0089d23d-8b89-42d7-85b8-034534fe9453", // UFC 281 vs Israel Adesanya       (2022-11-12) MW title

  // --- Khamzat Chimaev (MW) ---
  "e7569169-e92d-4f34-ab06-6cedb9bb4789", // UFC 328 vs Sean Strickland       (2026-05-09) MW title
  "81ee0fdf-bee0-4911-8c91-9718ef5fa482", // UFC 319 vs Dricus Du Plessis     (2025-08-16) MW title

  // --- Islam Makhachev (WW now, former LW) ---
  "eab763ca-5d01-4e3e-96db-3af23d4e7330", // UFC 322 vs Jack Della Maddalena  (2025-11-15) WW title
  "4e8868a8-8ac4-456e-8e41-6e086812daa3", // UFC 311 vs Renato Moicano        (2025-01-18) LW title
  "f1afe409-c54a-4d53-a6c3-bb6536fbdf08", // UFC 302 vs Dustin Poirier        (2024-06-01) LW title
  "8c09c4fd-6408-4cb7-a549-c83de419cb08", // UFC 294 vs Volkanovski 2         (2023-10-21) LW title
  "14e8e1b7-7737-4356-a231-e88bbed0595c", // UFC 284 vs Volkanovski 1         (2023-02-11) LW title
  "08bb907b-75fd-4af7-8b95-473941e8483e", // UFC 280 vs Charles Oliveira      (2022-10-22) LW title (vacant)

  // --- Ilia Topuria (LW now, former FW) ---
  "7dbd3c09-b6cd-447c-bd93-fc4376139eb7", // UFC 317 vs Charles Oliveira      (2025-06-28) LW title (vacant)
  "ffc36d5e-4881-4bdf-a8ac-8d7d477aa8a3", // UFC 308 vs Max Holloway          (2024-10-26) FW title
  "cda9db87-acdb-4024-bf0b-289bfad6cb9d", // UFC 298 vs Alexander Volkanovski (2024-02-17) FW title

  // --- Justin Gaethje (interim LW) ---
  "d888680c-fa68-47fb-8b9f-35f3b41a27d2", // UFC 324 vs Paddy Pimblett        (2026-01-24) interim LW title
  "39a6c2c3-7350-4ffb-b0ac-2f01f1db066a", // UFC 274 vs Charles Oliveira      (2022-05-07) LW title
  "402e6b67-5e1c-4131-9ab4-2740e2267968", // UFC 254 vs Khabib Nurmagomedov   (2020-10-24) LW title
  "6c338ca8-0c05-4e7d-bf92-b9291bd4c584", // UFC 249 vs Tony Ferguson         (2020-05-09) interim LW title

  // --- Alexander Volkanovski (FW) ---
  "5aeba8c9-c220-44b3-aed8-3fdd5652b3e3", // UFC 325 vs Diego Lopes 2         (2026-01-31) FW title
  "7bd98524-718e-4835-85cc-a5590ec72c79", // UFC 314 vs Diego Lopes 1         (2025-04-12) FW title (vacant)
  "7d69c83c-eab7-4fc3-b94b-bc06d7c7c741", // UFC 290 vs Yair Rodriguez        (2023-07-08) FW title
  "a9315097-35b4-42a6-91cc-76393e9db057", // UFC 276 vs Max Holloway 3        (2022-07-02) FW title
  "69d811ca-72f4-46b0-9540-ff4689e2a339", // UFC 273 vs Korean Zombie         (2022-04-09) FW title
  "97989a11-4ba7-41ab-9fca-b0798ae8988a", // UFC 266 vs Brian Ortega          (2021-09-25) FW title
  "ca0c6474-464e-4f5e-b858-e0b6de8fe490", // UFC 251 vs Max Holloway 2        (2020-07-11) FW title
  "4e081b72-0bff-4f1d-85fc-214ad7389246", // UFC 245 vs Max Holloway 1        (2019-12-14) FW title

  // --- Petr Yan (former BW champ) ---
  "ecdb40c4-4801-49a8-b39a-9101b376f9ed", // UFC 323 vs Merab Dvalishvili 2   (2025-12-06) BW title
  "111ccda1-42f7-45f1-b2ec-814fdff1904e", // UFC 273 vs Aljamain Sterling 2   (2022-04-09) BW title
  "60d4b96e-3efd-4fdb-8089-ca5a42667b46", // UFC 267 vs Cory Sandhagen        (2021-10-30) interim BW title
  "ff18ce2c-f87a-4b43-8075-87b1cd0c5fd9", // UFC 259 vs Aljamain Sterling 1   (2021-03-06) BW title (DQ loss)
  "80777d32-78d7-46cb-96e1-84cad63096a7", // UFC 251 vs Jose Aldo             (2020-07-11) BW title (vacant)

  // --- Joshua Van (FLW challenger) ---
  "d31d490d-2ffb-4ea9-8aaa-f96cce77955d", // UFC 323 vs Alexandre Pantoja     (2025-12-06) FLW title

  // --- Zhang Weili (SW) ---
  "2bf4c511-931f-4474-a41b-762a810b4bd4", // UFC 312 vs Tatiana Suarez        (2025-02-08) SW title
  "d07fe53b-780b-431c-94d6-d17efbf5ff10", // UFC 300 vs Yan Xiaonan           (2024-04-13) SW title
  "0b909120-0c18-4ba9-93f0-3c1257524331", // UFC 292 vs Amanda Lemos          (2023-08-19) SW title
  "1c9a2c8c-33bb-4f5c-b653-38c216f0adc5", // UFC 281 vs Carla Esparza         (2022-11-12) SW title
  "872fbf04-703e-4f98-8572-f763380e4539", // UFC 268 vs Rose Namajunas 2      (2021-11-06) SW title
  "98b29a87-e099-45b9-88e9-3e3470a0dac5", // UFC 261 vs Rose Namajunas 1      (2021-04-24) SW title
  "649a95e2-8246-46d0-8fa4-49c65da85911", // UFC 248 vs Joanna Jedrzejczyk    (2020-03-07) SW title
  "1d0e8f8a-9624-4af7-b8f1-71a70f42bbd6", // UFC FN Andrade vs Zhang          (2019-08-31) SW title

  // --- Valentina Shevchenko (FlyW + former BW challenger) ---
  "bc22987a-fda3-4c29-aab5-d09542560b1a", // UFC 315 vs Manon Fiorot          (2025-05-10) FlyW title
  "2fd5e96c-fd44-4046-b071-11fe000de920", // UFC 306 vs Alexa Grasso 2        (2024-09-14) FlyW title
  "2eaba757-6d32-49c1-a8f4-2263c65fbea0", // UFC FN Grasso vs Shev 2          (2023-09-16) FlyW title
  "496b0f44-16d4-470a-adcf-5d3612bb69f4", // UFC 285 vs Alexa Grasso 1        (2023-03-04) FlyW title
  "0c5ee48b-ca9e-4d73-9e56-c8bc0d670986", // UFC 275 vs Taila Santos          (2022-06-11) FlyW title
  "434ff80a-21f9-434b-9de3-ed7dd388979b", // UFC 266 vs Lauren Murphy         (2021-09-25) FlyW title
  "20abdf73-40b6-48be-9f9e-84aeb2a938f4", // UFC 261 vs Jessica Andrade       (2021-04-24) FlyW title
  "7030b5b8-4115-4b30-8415-027d42d2654a", // UFC 255 vs Jennifer Maia         (2020-11-21) FlyW title
  "9c8e15af-08ff-45cb-a7cb-9a599a156045", // UFC 247 vs Katlyn Cerminara      (2020-02-08) FlyW title
  "7d1c03d3-62ea-4e63-acef-6e50fa835904", // UFC FN Shev vs Carmouche 2       (2019-08-10) FlyW title
  "34c78393-0c94-416b-bbca-065bec1f533b", // UFC 238 vs Jessica Eye           (2019-06-08) FlyW title (inaugural)
  "bae7660c-cbae-4a05-9a38-d4e1f2b06a4f", // UFC 215 vs Amanda Nunes 2        (2017-09-09) BW title

  // --- Khabib Nurmagomedov (former LW champ) ---
  "4e0a3273-adf7-45f1-9f92-dc09187c29e7", // UFC 242 vs Dustin Poirier        (2019-09-07) LW title
  "d97e76c9-4afe-4bb2-9f36-b01e67b02c10", // UFC 229 vs Conor McGregor        (2018-10-06) LW title
  "ab636be2-a353-4abf-9844-22a268629366", // UFC 223 vs Al Iaquinta           (2018-04-07) LW title (vacant)

  // --- Conor McGregor (former FW + LW champ) ---
  "f3990995-bb6d-4dbe-9650-3d090d9c42dd", // UFC 205 vs Eddie Alvarez         (2016-11-12) LW title
  "9c9613d3-6171-4164-99f2-461b1d6d7c90", // UFC 194 vs Jose Aldo             (2015-12-12) FW title
];

const TITLE_BOUT_SET: ReadonlySet<string> = new Set(CURATED_TITLE_BOUT_IDS);

/** Returns true if the bout is a known title fight per the curated list. */
export function isCuratedTitleFight(boutId: string | null | undefined): boolean {
  if (!boutId) return false;
  return TITLE_BOUT_SET.has(boutId);
}
