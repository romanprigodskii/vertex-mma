"""The pre-registered segment grid — the whole point of the lab.

Every slice the search is allowed to look at is written down HERE, before any
of them is scored, and `lab_edge_segments.py` measures all of them and reports
all of them. That is what makes the Benjamini-Hochberg correction in the scan
meaningful: a q-value is a statement about how many slices were opened, and it
is a lie if the losing ones were quietly dropped before the count was taken.

The grid was designed by eight independent passes over the feature schema, one
per lens (style matchups, style x age, physical durability, market
microstructure, activity and layoff, experience and pedigree, form and
momentum, division and context), plus a completeness pass looking for what the
eight missed. Each pass could see the FEATURE columns and row counts and was
barred from seeing outcomes, probabilities or prices while choosing — the one
exception being the market-microstructure lens, for which the price IS the
segment definition.

Every entry carries a MECHANISM, not just a filter. "The market could be wrong
here because ..." is the part that separates a hypothesis from a slice, and a
segment that cannot state one does not belong in the grid.

The three `post_hoc__` entries at the end are marked as such because they are
NOT pre-registered: they came out of looking at the lean table during the same
session. They are kept because the effect they name is the largest in the lab,
and dropped from the multiplicity accounting of the pre-registered family so
they cannot dilute it.

CONVENTION. `expr_a` is written for the fighter the segment is ABOUT sitting in
slot A. The harness derives the B-side twin by swapping `_a` / `_b` suffixes
and takes the union, so membership never depends on scrape order.
`symmetric=True` marks a slice that names no side.
"""

SEGMENTS: list[dict] = [
    dict(
        name="market_microstructure__coinflip_band",
        family="market_microstructure",
        symmetric=True,
        expr_a="market_conf < 0.58",
        hypothesis=(
            "Near-pick'em prices are the one place the book has an incentive NOT to be "
            "sharp: the number is set to split two-way action, and there is no profit "
            "in moving a 52/48 line, so genuine 56/44 edges get compressed toward the "
            "balancing point and the posted price is deliberately shrunk toward 0.5. "
            "The model has no balancing constraint and reads elo/opponent-adjusted "
            "skill gaps at full amplitude, so its probabilities should be more spread "
            "and better-resolved than the book's here; expect the model to win on "
            "resolution in this band. "
        ),
    ),
    dict(
        name="market_microstructure__moderate_favourite_band",
        family="market_microstructure",
        symmetric=True,
        expr_a="(market_conf >= 0.62) & (market_conf < 0.72)",
        hypothesis=(
            "This band (roughly -165 to -260) is where recreational handle concentrates "
            "— a modest favourite is the most 'bettable' price and the standard parlay "
            "leg — so one-way public money on the recognisable name pushes the line "
            "past the true number more than in any other band. The model carries no "
            "name-recognition or popularity term, so it should be systematically less "
            "shaded; expect the model's favourite-side probability to sit below the "
            "book's and be better calibrated. "
        ),
    ),
    dict(
        name="market_microstructure__heavy_favourite_band",
        family="market_microstructure",
        symmetric=True,
        expr_a="market_conf >= 0.72",
        hypothesis=(
            "Classic favourite-longshot bias: bettors overpay for lottery-shaped "
            "longshot tickets, so the dog's implied probability overstates truth and, "
            "once the vig is stripped proportionally, the favourite is left "
            "underpriced. If that bias is present in MMA closing lines, the book's "
            "number in the tail is too close to 0.5 and a model that is confident here "
            "(and correct) beats it. Expect the model to be MORE confident than the "
            "book on the favourite and to gain log-loss when it is right. "
        ),
    ),
    dict(
        name="market_microstructure__split_favourite",
        family="market_microstructure",
        symmetric=True,
        expr_a="same_favourite == False",
        hypothesis=(
            "The only slice where the model can win or lose large log-loss: model and "
            "book name different fighters. Sign flips happen when opponent-adjusted "
            "skill ratings diverge from the surface record/streak/name that drives "
            "retail money and therefore the closing price — the book's number reflects "
            "aggregated betting opinion anchored on a fighter's win-loss record, the "
            "model's reflects who those wins came against. This is the decisive test of "
            "whether the model holds information the price does not; direction is "
            "unambiguous and the segment is self-falsifying if the model is merely "
            "noisy. "
        ),
    ),
    dict(
        name="market_microstructure__magnitude_gap_same_side",
        family="market_microstructure",
        symmetric=True,
        expr_a="(disagreement >= 0.12) & (same_favourite == True)",
        hypothesis=(
            "Model and book pick the same winner but disagree sharply on how sure to "
            "be. Books cap conviction on non-headline bouts for exposure and two-way- "
            "action reasons and are reluctant to post extreme numbers in markets they "
            "cannot lay off, so a 0.65 posted price can sit on top of a genuine 0.80 "
            "spot — the gap is a market constraint, not information. Isolating same- "
            "side disagreement tests the model's confidence SCALING free of any sign- "
            "error contamination; expect the model to win where its extra confidence is "
            "warranted. "
        ),
    ),
    dict(
        name="market_microstructure__five_round_headliner",
        family="market_microstructure",
        symmetric=True,
        expr_a="scheduled_rounds == 5",
        hypothesis=(
            "Two market forces coincide at championship distance. The card's heaviest "
            "public and name-recognition money lands on the headliner, shading the "
            "famous side; and books largely price the matchup fighter-vs-fighter "
            "without fully re-pricing the extra ten minutes, which systematically "
            "rewards volume, cardio and control time. The model consumes per-minute "
            "rate stats, avg_bout_seconds and control_per_min, so distance is "
            "implicitly in its features while the price under-adjusts for it; expect "
            "the model to favour the higher-output/grappling side relative to the book. "
        ),
    ),
    dict(
        name="market_microstructure__thin_prelim_market",
        family="market_microstructure",
        symmetric=True,
        expr_a="(is_main_event == 0) & (n_ranked == 0) & (min_prior_bouts <= 3)",
        hypothesis=(
            "Lowest-liquidity markets on the card: an undercard bout between two "
            "unranked fighters where at least one has almost no UFC record. These open "
            "late, carry the smallest limits, attract essentially no sharp modelling "
            "attention, and are priced off regional records and matchmaker signalling. "
            "The market's advantage over any model comes from aggregating informed "
            "money, and that aggregation is weakest exactly here — so if the model "
            "beats the book anywhere on liquidity grounds, this is the place. "
        ),
    ),
    dict(
        name="market_microstructure__priced_up_newcomer",
        family="market_microstructure",
        symmetric=False,
        expr_a="(prior_bouts_a <= 2) & (market_conf >= 0.62)",
        hypothesis=(
            "The book posts a confident price in a bout involving a UFC newcomer. That "
            "confidence cannot come from UFC-level sample; it comes from an undefeated "
            "regional record, Contender Series hype and the matchmaker's implied signal "
            "— all narrative anchors the public bets into. The model sees only pre-UFC "
            "bout counts and opponent-adjusted ratings with no hype term, so it should "
            "fade priced-up prospects; the directional probe tests exactly whether the "
            "newcomer SIDE is systematically over-priced by the market and better "
            "calibrated by the model. "
        ),
    ),
    dict(
        name="market_microstructure__womens_thin_handle",
        family="market_microstructure",
        symmetric=True,
        expr_a="is_women == 1",
        hypothesis=(
            "Women's bouts take a small fraction of total handle, so far fewer bettors "
            "build models for these divisions and lines are more often copied from an "
            "originator than corrected by informed money — the price does less work. "
            "Meanwhile the divisions are shallow and opponents recur, which makes the "
            "model's opponent-adjusted rating graph unusually well connected precisely "
            "where market attention is thinnest. Expect the model's edge, if any, to be "
            "larger here than in the men's pool. "
        ),
    ),
    dict(
        name="market_microstructure__stale_price_returnee",
        family="market_microstructure",
        symmetric=False,
        expr_a="layoff_days_a >= 450",
        hypothesis=(
            "When a fighter returns after 15+ months, the price is anchored on a "
            "reputation formed before the layoff: name recognition does not decay while "
            "form does, and the public bets the remembered fighter, so the returning "
            "side's number is stale rather than current. The model explicitly carries "
            "layoff_days, age and the traj_slpm/traj_sapm decline signals, so it "
            "discounts the returnee mechanically; the directional probe tests whether "
            "the model correctly fades the returning side that the market keeps propped "
            "up. "
        ),
    ),
    dict(
        name="activity_layoff__long_layoff_400",
        family="activity_layoff",
        symmetric=False,
        expr_a="layoff_days_a >= 400",
        hypothesis=(
            "The book prices ring rust as a blunt, roughly constant haircut on the "
            "returner (a headline 'he's been out 14 months' adjustment) because the "
            "news is public and the correction is folklore-driven; the model instead "
            "conditions the layoff on age, damage history, prior workload and a rating "
            "whose uncertainty widens with time, so it can separate a healthy 14-month "
            "absence from a decayed one. Expect the model to be better calibrated on "
            "returners, mostly by not over-discounting the clean layoffs the book "
            "flattens together. "
        ),
    ),
    dict(
        name="activity_layoff__extreme_layoff_520",
        family="activity_layoff",
        symmetric=False,
        expr_a="layoff_days_a >= 520",
        hypothesis=(
            "Dose-response probe on the same mechanism: at 17+ months out there are "
            "almost no recent comparables for a price-setter to lean on, so the closing "
            "line leans hardest on reputation from before the absence and on a flat "
            "rust rule, while the model's rating decay and layoff feature keep scaling "
            "with the actual number of days. If the returner edge is real it should be "
            "strongest here; if it vanishes at the extreme, the 400d result is noise "
            "rather than mechanism. "
        ),
    ),
    dict(
        name="activity_layoff__rusty_vs_active",
        family="activity_layoff",
        symmetric=False,
        expr_a="(layoff_days_a >= 365) & (layoff_days_b <= 200)",
        hypothesis=(
            "Direct activity mismatch: a year-plus returner against an opponent who has "
            "fought inside the last ~6 months. The recognisable returner attracts "
            "casual money (his name is why the fight is on the card at all) and his "
            "stale-but-flattering résumé anchors the price, while the active opponent "
            "has only unremarkable recent results to show. The model has no reputation "
            "channel and reads the active fighter's fresher form features, so it should "
            "sit on the active side of the book more often than the book deserves. "
        ),
    ),
    dict(
        name="activity_layoff__old_and_rusty",
        family="activity_layoff",
        symmetric=False,
        expr_a="(age_a >= 34) & (layoff_days_a >= 330)",
        hypothesis=(
            "The interaction this project has already documented empirically (35+ after "
            "730d+ underperform Elo-expectation by 15.7pp), widened to a usable sample. "
            "Rust and age-decline are multiplicative — an older fighter loses "
            "conditioning and reaction time during the layoff that he never regains — "
            "but the market applies the layoff haircut and the age haircut as separate, "
            "roughly additive adjustments. Expect the model to be better here "
            "specifically by being more bearish on the old returner than the closing "
            "line is. "
        ),
    ),
    dict(
        name="activity_layoff__young_and_rusty",
        family="activity_layoff",
        symmetric=False,
        expr_a="(age_a <= 29) & (layoff_days_a >= 270)",
        hypothesis=(
            "The mirror control for the age interaction, and a mechanism in its own "
            "right: a fighter under 30 off a long break is almost always a completed "
            "injury rehab, and young athletes return to baseline; the book's rust "
            "discount is largely age-blind, so it over-penalises exactly the returners "
            "who recover fully. Expect the model to be better on the bullish side here "
            "— the book too pessimistic on the young returner — which is the opposite "
            "direction from old_and_rusty and makes both results interpretable "
            "together. "
        ),
    ),
    dict(
        name="activity_layoff__both_rusty",
        family="activity_layoff",
        symmetric=True,
        expr_a="(layoff_days_a >= 250) & (layoff_days_b >= 250)",
        hypothesis=(
            "Both fighters have been out 8+ months, so the 'returner' narrative that "
            "normally drives the discount applies to each side and should cancel. If "
            "the book's layoff handling were a proper conditional model this "
            "cancellation would be automatic; if it is instead a reputation-weighted "
            "rule of thumb, it cancels unevenly and the price falls back to name "
            "recognition. The model applies a symmetric, data-derived rust term, so any "
            "residual asymmetry in the line is likely the book's, not the model's. "
        ),
    ),
    dict(
        name="activity_layoff__both_active",
        family="activity_layoff",
        symmetric=True,
        expr_a="max_layoff <= 150",
        hypothesis=(
            "Positive-control region for the model rather than a market-failure region: "
            "with neither fighter out more than five months, every stat input (form "
            "trajectory, strike/grapple rates, ratings) is fresh and the rust nuisance "
            "term is absent, so the model is operating where its features are least "
            "stale and its errors should be smallest. If the model cannot match the "
            "book even here, no layoff pocket elsewhere is credible; if it does, it "
            "isolates staleness as the model's main handicap. "
        ),
    ),
    dict(
        name="activity_layoff__rusty_striker",
        family="activity_layoff",
        symmetric=False,
        expr_a="(layoff_days_a >= 300) & (is_striker_a == 1)",
        hypothesis=(
            "Rust attacks timing, distance judgement and reaction speed first — "
            "precisely the faculties a distance striker's whole game rests on — while "
            "the book's layoff haircut is style-blind. A returning striker should "
            "therefore decay more than the flat discount implies, leaving him "
            "systematically over-priced. The model carries point-in-time style and "
            "striking-rate features alongside the layoff, so it can express a style- "
            "dependent rust penalty the line does not. "
        ),
    ),
    dict(
        name="activity_layoff__rusty_grappler",
        family="activity_layoff",
        symmetric=False,
        expr_a="(layoff_days_a >= 300) & (is_grappler_a == 1)",
        hypothesis=(
            "The opposite half of the same style-blind-haircut mechanism: wrestling and "
            "control games rest on strength, positional habit and grip — attributes "
            "that survive a layoff far better than striking timing — so a uniform rust "
            "discount over-penalises the returning grappler and leaves him under- "
            "priced. Paired with rusty_striker this makes the finding a directional "
            "contrast rather than a single slice, and a null on both kills the style- "
            "dependent-decay hypothesis cleanly. "
        ),
    ),
    dict(
        name="activity_layoff__layoff_after_loss",
        family="activity_layoff",
        symmetric=False,
        expr_a="(layoff_days_a >= 365) & (current_streak_a <= 0)",
        hypothesis=(
            "A fighter who lost and then disappeared for a year presents two negatives "
            "the market compresses into one story ('coming off a loss and a long "
            "layoff'), and stories tend to be over-priced: the discount overshoots what "
            "the two signals jointly warrant, and many such absences are contractual, "
            "visa or personal rather than injury, i.e. carry no physical cost at all. "
            "The model prices the loss and the layoff as separate measured features, so "
            "it should be less bearish than the close and better calibrated on these "
            "returners. "
        ),
    ),
    dict(
        name="experience_pedigree__both_ranked_elite",
        family="experience_pedigree",
        symmetric=True,
        expr_a="n_ranked == 2",
        hypothesis=(
            "Both fighters are currently in the top-15, so both have long UFC-level "
            "records against measurable opposition: this is exactly where the model's "
            "opponent-adjusted ratings (elo/glicko, str_off/grap_off, style axes) are "
            "estimated from the most data and carry the least shrinkage, while the "
            "book's structural advantage — private information the model can never see "
            "(camp reports, injuries, weight-cut trouble) — is roughly constant per "
            "bout. Relative model quality should therefore peak where its own inputs "
            "are richest; expect the model's log-loss gap to the closing line to be at "
            "its narrowest here, and plausibly negative. "
        ),
    ),
    dict(
        name="experience_pedigree__unranked_deep_veterans",
        family="experience_pedigree",
        symmetric=True,
        expr_a="(n_ranked == 0) & (min_prior_bouts >= 5)",
        hypothesis=(
            "Neither fighter is ranked, yet both have five or more prior UFC bouts — "
            "the gatekeeper/journeyman prelim churn. The model has a deep, fully "
            "converged sample on both men, but these fights sit on early prelims where "
            "handle is small, limits are low and sharp attention is scarce, so the "
            "closing line is corrected far less than a main-card price. This is the "
            "classic pocket where a well-informed power rating beats a lightly-traded "
            "market: expect the model to close the gap or win outright. "
        ),
    ),
    dict(
        name="experience_pedigree__ranked_pedigree_vs_never_ranked",
        family="experience_pedigree",
        symmetric=False,
        expr_a="(rank_days_since_a == rank_days_since_a) & (rank_days_since_b != rank_days_since_b)",
        hypothesis=(
            "One fighter has appeared in the divisional rankings at some point "
            "(rank_days_since is populated); the opponent never has. The ranking is a "
            "lagging, media-voted credential that both the public and the book anchor "
            "on, and the name-recognition asymmetry pulls recreational money onto the "
            "pedigreed side, which books tolerate rather than fully correct. The model "
            "has no rank badge to anchor to and prices both men on current opponent- "
            "adjusted form, so it should be systematically less impressed by the "
            "pedigree; expect a directional bias where the market overprices the ever- "
            "ranked side. "
        ),
    ),
    dict(
        name="experience_pedigree__title_experience_mismatch",
        family="experience_pedigree",
        symmetric=False,
        expr_a="(title_bouts_a >= 1) & (title_bouts_b == 0)",
        hypothesis=(
            "One fighter has been in at least one UFC title bout, the other never has. "
            "A title shot is a lagging indicator: it is awarded for a peak that has "
            "already happened, so 'former title challenger' correlates with being past "
            "prime as much as with being elite. The market treats it as a permanent "
            "quality stamp because it is the single most salient line on a fighter's "
            "record, whereas the model carries title_bouts only as one feature next to "
            "decline signals (traj_sapm, finish_against, age). Expect the market to "
            "overprice the title-credentialed side and the model to be relatively "
            "better here. "
        ),
    ),
    dict(
        name="experience_pedigree__rank_sliding_180d",
        family="experience_pedigree",
        symmetric=False,
        expr_a="rank_delta180_a >= 1",
        hypothesis=(
            "One fighter has dropped at least one rank slot in the last 180 days "
            "(positive rank_delta180 = larger rank number = falling). Reputation is the "
            "slowest-updating quantity in a betting market: recreational money keeps "
            "backing the fighter it remembers at his peak, and books shade toward that "
            "side rather than fully repricing an ongoing slide. The model reads the "
            "decline directly from rank movement plus co-moving decay features (rising "
            "traj_sapm, falling streak). Expect the market to be slow on the sliding "
            "side and the model to be relatively sharper. "
        ),
    ),
    dict(
        name="experience_pedigree__faded_former_ranked",
        family="experience_pedigree",
        symmetric=False,
        expr_a="rank_days_since_a >= 365",
        hypothesis=(
            "One fighter was ranked once but has been out of the top-15 for a year or "
            "more — a known name now fighting off the rankings. The residual brand "
            "keeps drawing public money long after the underlying quality is gone, and "
            "the book prices to that flow; simultaneously the fighter's recent "
            "opposition is weak enough that the raw record still looks respectable. The "
            "model has no notion of name value and sees only the current opponent- "
            "adjusted ratings and the year-plus absence from the rankings, so it should "
            "discount the faded name faster than the closing line does. "
        ),
    ),
    dict(
        name="experience_pedigree__hot_streak_vs_flat",
        family="experience_pedigree",
        symmetric=False,
        expr_a="(current_streak_a >= 3) & (current_streak_b <= 0)",
        hypothesis=(
            "One fighter rides a three-plus fight win streak against an opponent who is "
            "level or on a losing run. Hot-hand/recency bias is the best-documented "
            "bias in sports betting, and UFC streaks are partly manufactured by "
            "matchmaking — three wins over hand-picked opposition move the line far "
            "more than they move an opponent-adjusted rating. The model's elo/glicko "
            "and str_off/grap_off discount opponent quality explicitly, so it should be "
            "less seduced by the streak; expect the market to overprice the streaking "
            "side. "
        ),
    ),
    dict(
        name="experience_pedigree__regional_mileage_mismatch",
        family="experience_pedigree",
        symmetric=False,
        expr_a="(preufc_bouts_a >= 15) & (preufc_bouts_b <= 8)",
        hypothesis=(
            "One fighter arrived with a long regional career (15+ pre-UFC bouts) "
            "against an opponent with a short one. The market correctly discounts "
            "regional records as low-quality wins, but in doing so it also discards the "
            "volume information: fifteen-plus prior professional fights is accumulated "
            "damage and mileage that never shows up in the UFC record the market prices "
            "off. The model carries preufc_bouts as an explicit feature alongside "
            "durability signals (kd_absorbed, finish_against, traj_sapm), so it should "
            "catch hidden wear the line ignores; expect the model to be relatively "
            "better and to fade the high-mileage side. "
        ),
    ),
    dict(
        name="experience_pedigree__ufc_newcomer_side",
        family="experience_pedigree",
        symmetric=False,
        expr_a="prior_bouts_a <= 1",
        hypothesis=(
            "At least one fighter is a UFC debutant or has a single promotional bout. "
            "Debut prices are the most narrative-driven in the sport — Contender Series "
            "darlings and signed regional champions arrive with promotional hype, the "
            "public buys the story, and there is little sharp money because nobody has "
            "UFC-adjusted data either. The model is hype-blind and falls back on "
            "measurable regional record, physicals and elo priors with proper "
            "shrinkage, which is a poor absolute prior but an unbiased one. Expect the "
            "market's newcomer premium to be systematic and the model to be relatively "
            "better, fading the hyped debutant. "
        ),
    ),
    dict(
        name="style_matchups__striker_vs_universal",
        family="style_matchups",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (is_universal_b == 1)",
        hypothesis=(
            "The user's headline pairing: the boxer against the all-rounder. A pure "
            "striker gives the market a highlight reel — knockouts are salient, "
            "memorable and pull recreational money — while the all-rounder's edge is "
            "route-diversity (he can win standing, on the mat, or on the cards) which "
            "produces no memorable footage and no narrative. The model prices paths-to- "
            "victory through opponent-adjusted grap_off/str_def rather than through "
            "finish salience, so it should sit higher on the universal fighter than the "
            "closing line does. "
        ),
    ),
    dict(
        name="style_matchups__striker_vs_grappler",
        family="style_matchups",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (is_grappler_b == 1)",
        hypothesis=(
            "The archetype pairing with the loudest narrative in the sport. Markets "
            "price the two fighters largely additively — each side's reputation and "
            "record — and under-weight the multiplicative style interaction, and where "
            "they do price the interaction they apply the archetype label ('wrestler "
            "beats striker') rather than the specific numbers. The model conditions on "
            "both sides' measured, opponent-adjusted td_def/grap_def/grap_off, so it "
            "should be sharper wherever the stereotype is applied bluntly to a striker "
            "who actually defends takedowns or a grappler who cannot land them. "
        ),
    ),
    dict(
        name="style_matchups__low_output_vs_active",
        family="style_matchups",
        symmetric=False,
        expr_a="(is_low_output_a == 1) & (is_low_output_b == 0)",
        hypothesis=(
            "The low-output archetype is the unentertaining fighter: no finishes, low "
            "volume, decision-heavy. Recreational money is systematically repelled by "
            "such fighters and flows onto the exciting opponent, and on low-liquidity "
            "mid-card bouts that one-way flow drags the close past fair value. The "
            "model is entirely indifferent to entertainment value and prices grinding, "
            "low-variance decision paths at face value, so it should sit higher on the "
            "low-output fighter than the market close does. "
        ),
    ),
    dict(
        name="style_matchups__mirror_style_match",
        family="style_matchups",
        symmetric=True,
        expr_a="(style_a == style_b) & (style_known_a == 1) & (style_known_b == 1)",
        hypothesis=(
            "In a same-archetype bout the stylistic storyline that normally drives line "
            "movement has nothing to say, so the market falls back on name recognition, "
            "record and recency — the inputs it prices worst. The model's opponent- "
            "adjusted skill ratings are at their most informative exactly here, because "
            "the style interaction cancels and the bout reduces to a clean skill "
            "differential along a single axis. Expect the model to be better calibrated "
            "overall in mirror matches, in both directions. "
        ),
    ),
    dict(
        name="style_matchups__southpaw_vs_orthodox",
        family="style_matchups",
        symmetric=False,
        expr_a="(stance_a == 'southpaw') & (stance_b == 'orthodox')",
        hypothesis=(
            "The southpaw advantage is real but second-order: it is swamped in the "
            "price by the fighters' own quality, and markets apply it inconsistently, "
            "usually only when a broadcast narrative happens to raise it for a given "
            "bout. Because southpaws are only ~20% of the field, the orthodox fighter's "
            "deficit is structural and under-rehearsed rather than fighter-specific. "
            "The model carries stance as an explicit feature applied uniformly to every "
            "bout, so it should sit higher on the southpaw than the close does. NB "
            "stance values in this frame are lowercase. "
        ),
    ),
    dict(
        name="style_matchups__striker_weak_tdd_vs_wrestler",
        family="style_matchups",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (td_def_a < 0.70) & (td_per15_b >= 1.2)",
        hypothesis=(
            "The named classic: a striker with a genuine takedown-defence hole against "
            "a fighter who actually shoots. Takedown defence is a number that never "
            "appears on a broadcast tale-of-the-tape, while knockout power is exactly "
            "what the public does see, so the market prices the striker's threat fully "
            "and the wrestler's path only through reputation. The model conditions on "
            "the measured td_def directly, so it should favour the takedown-heavy "
            "fighter more than the closing line does. "
        ),
    ),
    dict(
        name="style_matchups__wrestler_vs_elite_tdd",
        family="style_matchups",
        symmetric=False,
        expr_a="(td_per15_a >= 2.0) & (td_def_b >= 0.75)",
        hypothesis=(
            "The mirror image of the classic, and the canonical overrated-wrestler "
            "spot. 'He'll just take him down' is the most confidently repeated line in "
            "MMA handicapping and it attaches to the wrestler's archetype rather than "
            "to this specific opponent's stuff rate; when the opponent's takedown "
            "defence is genuinely elite the wrestler's entire path to victory is gone, "
            "yet the price still carries the story. The model sees the opponent's "
            "td_def as a first-class feature, so it should sit lower on the high-volume "
            "takedown fighter than the close does. By construction this shares almost "
            "no bouts with the weak-TDD segment, so the two together test the "
            "interaction in both directions. "
        ),
    ),
    dict(
        name="style_matchups__grapple_axis_gap",
        family="style_matchups",
        symmetric=False,
        expr_a="(grapple_a - grapple_b) >= 0.90",
        hypothesis=(
            "Continuous version of the grappling mismatch, ~75th percentile of the "
            "observed gap. Grappling dominance is invisible on a broadcast — control "
            "time and positional advance generate no highlight and sit outside the "
            "public's mental model of 'winning' — so a market fed by public flow "
            "chronically under-prices the grinder even when he is the correct side. The "
            "model carries control_per_min, td_per15 and opponent-adjusted grap_off as "
            "first-class features with no aesthetic discount, so it should sit higher "
            "on the higher-grapple fighter than the close does. "
        ),
    ),
    dict(
        name="style_matchups__strike_axis_gap",
        family="style_matchups",
        symmetric=False,
        expr_a="(strike_a - strike_b) >= 0.65",
        hypothesis=(
            "The matched counterpart to the grapple-axis gap, and the place the market "
            "is most likely already right — which makes it the informative control: if "
            "the model gains on the grapple axis but not the strike axis, that "
            "asymmetry is itself the finding. It also carries one exploitable confound: "
            "the strike axis is a VOLUME measure (slpm, distance share), not a power or "
            "effectiveness measure, and the market conflates volume with danger, over- "
            "betting the high-output point-fighter against a low-volume, high-accuracy "
            "counter-striker. The model prices volume and opponent-adjusted "
            "str_off/str_def as separate quantities. "
        ),
    ),
    dict(
        name="style_matchups__specialist_vs_generalist",
        family="style_matchups",
        symmetric=False,
        expr_a="(((strike_a - grapple_a) >= 0.70) | ((grapple_a - strike_a) >= 0.70)) & ((strike_b - grapple_b) <= 0.35) & ((grapple_b - strike_b) <= 0.35)",
        hypothesis=(
            "The one-dimensional fighter against one who is not, in continuous form and "
            "agnostic to which dimension. A specialist hands the market a clean, "
            "confident story ('he keeps it standing' / 'he drags him down'), and "
            "confident stories are what draw money and move a close; the balanced "
            "fighter offers no headline but strictly more ways to win and fewer ways to "
            "be nullified. The model prices both axes with no narrative prior and no "
            "reward for legibility, so it should sit higher on the balanced fighter "
            "than the close does. Overlaps little with the archetype pairings (Jaccard "
            "<=0.19 against every other segment here), so it earns its own slot. "
        ),
    ),
    dict(
        name="style_and_age__ageing_striker_vs_younger",
        family="style_and_age",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (age_a >= 33) & (age_b <= age_a - 4)",
        hypothesis=(
            "Striking rests on reflex, foot speed and chin — the fastest-decaying "
            "attributes — so a 33+ striker giving up four or more years is the sharpest "
            "decline case. The book anchors an ageing striker's price on name "
            "recognition and highlight-reel equity, which decays far slower than the "
            "underlying physical trait, while the model reads current output and "
            "absorption rates with no reputation term. Expect the model to be more "
            "bearish on the veteran striker than the close, and right. "
        ),
    ),
    dict(
        name="style_and_age__ageing_grappler_vs_younger",
        family="style_and_age",
        symmetric=False,
        expr_a="(is_grappler_a == 1) & (age_a >= 33) & (age_b <= age_a - 3)",
        hypothesis=(
            "The mirror image and the core of the domain claim: wrestling and BJJ are "
            "technique, positional IQ and strength, which hold into the late 30s, "
            "unlike speed. The market applies a fairly generic age discount calibrated "
            "on the striker-dominated majority of fighters, so it over-fades old "
            "grapplers specifically. The model keys on takedown and control rates that "
            "are still intact at 35, so it should fade the veteran less than the book "
            "does. "
        ),
    ),
    dict(
        name="style_and_age__ageing_striker_vs_grappling_base",
        family="style_and_age",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (age_a >= 33) & (grapple_b > 0)",
        hypothesis=(
            "A style matchup whose damage is age-conditional: the first things an "
            "ageing striker loses are the legs behind his takedown defence and the "
            "scramble cardio to stand back up, so an opponent with an above-median "
            "grappling axis attacks exactly the dimension that decayed. The market "
            "prices the striker-versus-grappler matchup and the age discount as "
            "separate additive terms; it is the interaction — age eroding TDD in "
            "particular — that is hard to price and that the model's opponent-adjusted "
            "grappling features pick up. "
        ),
    ),
    dict(
        name="style_and_age__both_veterans",
        family="style_and_age",
        symmetric=True,
        expr_a="(age_a >= 33) & (age_b >= 33)",
        hypothesis=(
            "Both fighters 33+, so both are simultaneously subject to durability cliffs "
            "and non-linear decline, making outcomes high-variance. With two declining "
            "veterans the book's most reliable soft input — which man carries more name "
            "equity — is at its least informative, and prices tend to herd toward the "
            "more famous of the two. A purely stats-driven model has its best relative "
            "footing here; expect it to be better calibrated and less overconfident "
            "than the closing line. "
        ),
    ),
    dict(
        name="style_and_age__old_striker_absorbing_more",
        family="style_and_age",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (age_a >= 33) & (traj_sapm_a >= 0.3)",
        hypothesis=(
            "traj_sapm above zero means the fighter is absorbing meaningfully more "
            "strikes in his last three bouts than his own career baseline — a live, "
            "measured decline signal, sampled in the one population where decline is "
            "terminal rather than a blip. Closing lines move on results and narrative, "
            "not on absorption trend, so a fighter can keep winning while quietly "
            "eroding and stay priced as elite. The model sees the trajectory feature "
            "directly and should be more bearish, and correct. "
        ),
    ),
    dict(
        name="style_and_age__old_fragile_chin",
        family="style_and_age",
        symmetric=False,
        expr_a="(age_a >= 34) & (finish_against_per_bout_a >= 0.25)",
        hypothesis=(
            "Chin and durability decay fastest of all attributes and do so non-linearly "
            "— once a chin goes it does not come back — and a 34+ fighter already "
            "finished in a quarter or more of his bouts is the compounding case. "
            "Markets systematically regress knockout losses toward the mean by treating "
            "them as partly variance, whereas accumulated finish-against behaves much "
            "more like a persistent trait at this age. Expect the model to price the "
            "fragile veteran lower than the book and to be vindicated. "
        ),
    ),
    dict(
        name="style_and_age__prospect_vs_veteran_gatekeeper",
        family="style_and_age",
        symmetric=False,
        expr_a="(age_a <= 29) & (prior_bouts_a <= 8) & (age_b >= 33)",
        hypothesis=(
            "The classic prospect-versus-gatekeeper shape: a young fighter with a thin "
            "UFC record against a 33+ veteran. Reputation-weighted money and the book's "
            "preference for the longer, more legible sample both tilt the price toward "
            "the veteran, while the prospect's short record reads as an absence of "
            "evidence. The model's rating uncertainty and trajectory terms treat a thin "
            "record as genuinely uncertain rather than as weak, so it should sit "
            "relatively higher on the prospect than the close. "
        ),
    ),
    dict(
        name="style_and_age__old_control_wrestler",
        family="style_and_age",
        symmetric=False,
        expr_a="(age_a >= 34) & (control_per_min_a >= 15)",
        hypothesis=(
            "A 34+ fighter with heavy top-control time has a game built on position and "
            "strength rather than speed, and it is the archetype the blanket old- "
            "fighter discount fits worst: grinding control is the last skill to decay "
            "and it simultaneously suppresses the opponent's routes to victory. The "
            "market cannot easily condition its age curve on how a fighter wins, so it "
            "over-fades these veterans. The model reads control_per_min and opponent- "
            "adjusted grappling offence directly and should be less bearish, and "
            "better. "
        ),
    ),
    dict(
        name="style_and_age__old_distance_striker",
        family="style_and_age",
        symmetric=False,
        expr_a="(is_striker_a == 1) & (age_a >= 33) & (distance_share_a >= 0.78)",
        hypothesis=(
            "A 33+ striker fighting over three-quarters of his time at range is "
            "maximally dependent on footwork and reaction time, the attributes with the "
            "steepest age curve, and has no grappling fallback once they go. The book "
            "struggles to separate the old striker who can still wrestle from the old "
            "striker who only has range, since both carry similar records and similar "
            "name equity. Expect the model, which sees distance_share and the grappling "
            "axis separately, to be more bearish on the pure range veteran. "
        ),
    ),
    dict(
        name="style_and_age__speed_matchup_ageing_striker",
        family="style_and_age",
        symmetric=False,
        expr_a="(strike_a > 0) & (age_a >= 33) & (strike_b > 0) & (age_b <= age_a - 4)",
        hypothesis=(
            "Both fighters sit on the strike-heavy side of the median and the older man "
            "is 33+ and at least four years senior, so neither has a grappling buffer "
            "to hide a fading physical edge behind. When the bout will be contested "
            "standing, the age differential converts into outcome more directly than "
            "anywhere else. The market prices age as a roughly linear across-the-board "
            "discount rather than one whose slope depends on where the fight happens; "
            "the model should apply a correctly steeper age penalty here. "
        ),
    ),
    dict(
        name="physical_durability__reach_edge_superior_striker",
        family="physical_durability",
        symmetric=False,
        expr_a="((reach_a - reach_b) >= 8) & (str_off_a >= str_off_b)",
        hypothesis=(
            "Reach only converts into damage when the man holding it is actually the "
            "better striker, but the tale-of-the-tape reach number is priced as a "
            "uniform main effect because conditioning it requires an opponent-adjusted "
            "striking rating the public does not have. Where the 8cm+ edge is held by "
            "the genuinely superior striker the edge is real and under-priced, so the "
            "model should be MORE confident in the long fighter than the closing line "
            "and beat it there. "
        ),
    ),
    dict(
        name="physical_durability__reach_edge_inferior_striker",
        family="physical_durability",
        symmetric=False,
        expr_a="((reach_a - reach_b) >= 8) & (str_off_a < str_off_b)",
        hypothesis=(
            "The disjoint other half of the reach>=8 pool: the long fighter is the "
            "WORSE opponent-adjusted striker. Reach is the single most-quoted number in "
            "every preview and drives recreational money and the opening line, so a big "
            "but unusable reach edge is the classic salient-yet-empty attribute; the "
            "model never sees a tape graphic, only str_off/str_def. Expect the book "
            "shaded toward the long fighter and the model correctly lower on him. "
            "Together with the segment above this answers whether a big physical edge "
            "is over- or under-priced, split by whether it is usable. "
        ),
    ),
    dict(
        name="physical_durability__net_damage_deficit",
        family="physical_durability",
        symmetric=False,
        expr_a="(sapm_a - slpm_a) >= 1.0",
        hypothesis=(
            "A fighter absorbing a full strike per minute more than he lands has been "
            "paid by durability, not dominance. The market prices the W-L column and "
            "the eye test of a man who keeps surviving; the model prices the per-minute "
            "damage exchange directly, and a chronic damage deficit is a leading "
            "indicator that the surviving stops working before the record shows it. "
            "Expect the model below the line on such a fighter, and right. "
        ),
    ),
    dict(
        name="physical_durability__fragile_chin_vs_power",
        family="physical_durability",
        symmetric=False,
        expr_a="(kd_absorbed_per_fight_a >= 0.25) & (kd_per_fight_b >= 0.35)",
        hypothesis=(
            "A chin liability is only cashable by an opponent with the power to cash "
            "it. Lines move for main effects (a puncher is shaded up against everyone, "
            "a recently-dropped fighter is shaded down against everyone) but handle "
            "this specific interaction crudely; the model carries both rates "
            "simultaneously and multiplies them. Expect the model materially lower on "
            "the fragile fighter than the line in exactly this pairing, and right. "
        ),
    ),
    dict(
        name="physical_durability__chin_durability_mismatch",
        family="physical_durability",
        symmetric=False,
        expr_a="(kd_absorbed_per_fight_a >= 0.25) & (kd_absorbed_per_fight_b <= 0.05)",
        hypothesis=(
            "A pure durability gap: one man is dropped roughly every fourth fight, the "
            "other essentially never. Knockdowns-absorbed per fight is not a broadcast "
            "graphic and is absent from most public handicapping, so the market "
            "substitutes record and recency for it. Chin erosion is monotone and "
            "irreversible, so the fragile man's true win probability drifts steadily "
            "below his record-based price. Expect the model lower on him than the line. "
        ),
    ),
    dict(
        name="physical_durability__finished_often",
        family="physical_durability",
        symmetric=False,
        expr_a="finish_against_per_bout_a >= 0.4",
        hypothesis=(
            "Deliberately the OPPOSITE direction to the two chin segments above, "
            "separated by salience: being stopped in 40%+ of bouts is the loudest, most "
            "public durability fact there is, and vivid recent KO losses are the "
            "archetypal over-reaction trigger (the 'he is done, fade him' narrative is "
            "the most popular bet in MMA). Where the market over-corrects, a smoothed "
            "per-bout rate beats the memory of the last violent finish, so the model "
            "should be HIGHER on the frequently-finished fighter than the line and "
            "right. If both this and the chin segments hit in their stated directions, "
            "salience is the moderator. "
        ),
    ),
    dict(
        name="physical_durability__absorption_spike",
        family="physical_durability",
        symmetric=False,
        expr_a="traj_sapm_a >= 1.5",
        hypothesis=(
            "traj_sapm is last-3 absorption minus career baseline, so this selects "
            "fighters currently eating 1.5 more strikes per minute than they ever have "
            "— live decline that has not yet produced a loss, since a declining fighter "
            "often keeps winning for two or three more bouts. Power ratings and public "
            "perception update on results, not on how much damage the win cost; the "
            "model reads the deterioration in flight. Expect the model below the line "
            "on the declining fighter, and right. "
        ),
    ),
    dict(
        name="physical_durability__veteran_mileage",
        family="physical_durability",
        symmetric=False,
        expr_a="(prior_bouts_a >= 10) & (avg_bout_seconds_a >= 700)",
        hypothesis=(
            "Accumulated octagon minutes: ten-plus UFC bouts averaging nearly twelve "
            "minutes each is a decade of wars, and that physical bill comes due as a "
            "step change rather than a slope. Books price the current form curve and "
            "have no cumulative-damage term, so the mileage tax is not in the number "
            "until a bad night puts it there. The model carries both bout count and "
            "average bout length. Expect the model below the line on the high-mileage "
            "veteran. "
        ),
    ),
    dict(
        name="physical_durability__defence_skill_gap",
        family="physical_durability",
        symmetric=False,
        expr_a="(str_def_a >= 0.5) & (str_def_b <= -0.5)",
        hypothesis=(
            "Damage avoidance is the other half of durability, and the public striking- "
            "defence number is a raw percentage badly contaminated by opponent quality: "
            "a fighter who has faced low-output opposition looks defensively sound. "
            "str_def here is opponent-adjusted, so it separates genuinely hard-to-hit "
            "from merely unchallenged. Where the adjusted gap is a full unit wide in "
            "both directions, the raw stat the market anchors on disagrees with the "
            "truth. Expect the model more confident in the defensively superior fighter "
            "than the line. "
        ),
    ),
    dict(
        name="physical_durability__both_iron_chins",
        family="physical_durability",
        symmetric=True,
        expr_a="(finish_against_per_bout_a <= 0.1) & (finish_against_per_bout_b <= 0.1)",
        hypothesis=(
            "Neither man has a chin liability, so the bout is very unlikely to be "
            "decided by one exchange and instead resolves on fifteen minutes of "
            "accumulated volume and control - a near-deterministic function of "
            "measurable per-minute rates. The book's price carries a stoppage-risk and "
            "puncher-reputation premium that has nothing to buy in this regime, while "
            "per-minute rate features and opponent-adjusted ratings are exactly what a "
            "decision outcome depends on. Expect the model sharper here and less "
            "deferential to the favourite than the line. "
        ),
    ),
    dict(
        name="form_momentum__hot_streak_vs_skid",
        family="form_momentum",
        symmetric=False,
        expr_a="(current_streak_a >= 2) & (current_streak_b <= -1)",
        hypothesis=(
            "The W/L run is the most legible input a casual bettor has, and a 2+ win "
            "streak facing a fighter coming off a loss is the most narratively lopsided "
            "picture a card produces. Streaks are heavily matchmaking-driven (streaking "
            "prospects get fed, skidding veterans get soft landings), so the streak "
            "overstates the true level gap; the model's elo/glicko/str_off/grap_off are "
            "opponent-adjusted and already contain those wins at proper weight. Expect "
            "the market to be too confident on the streaker and the model's flatter "
            "number to score better. "
        ),
    ),
    dict(
        name="form_momentum__long_win_streak_4plus",
        family="form_momentum",
        symmetric=False,
        expr_a="current_streak_a >= 4",
        hypothesis=(
            "Regression to the mean on a heavy-tailed order statistic: a 4+ streak is "
            "mostly a run of favourable matchmaking plus variance rather than a step- "
            "change in level. The market treats each additional win as fresh evidence "
            "and compounds it into the price, whereas the model shrinks toward a rating "
            "that already counted those same wins with opponent weighting, so it does "
            "not double-count them. Expect the market to be too high on the long-streak "
            "fighter. "
        ),
    ),
    dict(
        name="form_momentum__off_loss_strong_career",
        family="form_momentum",
        symmetric=False,
        expr_a="(current_streak_a <= -1) & (prior_win_rate_a >= 0.65) & (prior_bouts_a >= 6)",
        hypothesis=(
            "Classic buy-low recency over-reaction. Requiring 6+ prior UFC bouts and a "
            "65%+ career rate means the long-run quality signal is well-measured and "
            "stable, while the market marks the fighter down on the single most recent "
            "outcome — the one data point everyone saw. The model weighs the whole "
            "career through elo and opponent-adjusted ratings and does not over-weight "
            "the last result. Expect the market to be too low on the veteran coming off "
            "a loss. "
        ),
    ),
    dict(
        name="form_momentum__both_coming_off_loss",
        family="form_momentum",
        symmetric=True,
        expr_a="(current_streak_a <= -1) & (current_streak_b <= -1)",
        hypothesis=(
            "Market-microstructure rather than handicapping: loser-vs-loser bouts sit "
            "at the bottom of prelim cards and attract the least betting handle of "
            "anything on the card, and closing-line efficiency scales with volume — "
            "these lines move least from the opener and so retain the most opening- "
            "price error. The model applies identical machinery regardless of card "
            "position and has no attention deficit. No side is favoured a priori, so "
            "the edge should appear as a general accuracy gain, not a directional bias. "
        ),
    ),
    dict(
        name="form_momentum__finisher_vs_durable",
        family="form_momentum",
        symmetric=False,
        expr_a="(prior_finish_rate_a >= 0.7) & (finish_against_per_bout_b <= 0.05)",
        hypothesis=(
            "The market prices a finish threat as a property of the fighter — a 70%+ "
            "finish rate reads as 'he knocks everybody out' — rather than as a property "
            "of the matchup. An opponent who has essentially never been finished across "
            "his UFC run structurally denies that path, which is exactly the condition "
            "the narrative ignores. The model carries opponent durability explicitly "
            "(finish_against_per_bout, kd_absorbed_per_fight, td_def) and so conditions "
            "the finish threat on who is standing across from him. Expect the market to "
            "be too high on the finisher. "
        ),
    ),
    dict(
        name="form_momentum__live_decline_absorbing",
        family="form_momentum",
        symmetric=False,
        expr_a="(traj_sapm_a >= 1.0) & (age_a >= 32)",
        hypothesis=(
            "Physical decline shows up in damage absorbed before it shows up in the W/L "
            "column. traj_sapm is the last-3 absorbed-strike rate minus career "
            "baseline, so >=1.0 at age 32+ marks a fighter taking materially more "
            "punishment than he historically has — while possibly still winning. The "
            "market updates on outcomes and on names and therefore lags this by a fight "
            "or two; the model reads the trajectory feature directly. Expect the market "
            "to be too high on the declining older fighter. "
        ),
    ),
    dict(
        name="form_momentum__unbeaten_small_sample",
        family="form_momentum",
        symmetric=False,
        expr_a="(prior_bouts_a <= 3) & (prior_win_rate_a >= 0.99)",
        hypothesis=(
            "Regression to the mean on a tiny sample. A 1-0/2-0/3-0 UFC record carries "
            "almost no information, but an unblemished record plus prospect hype is "
            "precisely what the market extrapolates from, and short-sample fighters "
            "have no counter-evidence to anchor against. The model shrinks toward the "
            "prior through glicko_cons (rating deviation is large on few bouts) and "
            "carries preufc_bouts as separate evidence. Expect the market to be too "
            "high on the unbeaten short-sample fighter. "
        ),
    ),
    dict(
        name="form_momentum__long_layoff_after_loss",
        family="form_momentum",
        symmetric=False,
        expr_a="(current_streak_a <= -1) & (layoff_days_a >= 300)",
        hypothesis=(
            "Two negatives compound in the narrative — he lost, then vanished for the "
            "better part of a year — and with no newer data the market's read stays "
            "anchored on his last and worst performance. Empirically a post-loss layoff "
            "is frequently injury, a camp change or a deliberate reset rather than "
            "decline, so the compounding is not justified. The model treats layoff_days "
            "as one bounded feature alongside an unchanged career rating rather than as "
            "a story that multiplies the loss. Expect the market to be too low on the "
            "returning fighter. "
        ),
    ),
    dict(
        name="form_momentum__output_spike_recency",
        family="form_momentum",
        symmetric=False,
        expr_a="traj_slpm_a >= 2.0",
        hypothesis=(
            "A last-3 striking rate 2+ significant strikes per minute above career "
            "baseline is usually a matchup artifact — a passive or defensively porous "
            "opponent, or a long fight that never hit the mat — and it regresses. It is "
            "also exactly what generates the highlight tape that pulls money in, so the "
            "market reads a genuine level-up. The model sees traj_slpm and the career "
            "slpm/str_off baseline side by side and can weigh the spike against the "
            "longer record. Expect the market to be too high on the fighter who just "
            "appeared to improve. "
        ),
    ),
    dict(
        name="form_momentum__hot_recent_finisher",
        family="form_momentum",
        symmetric=False,
        expr_a="(recent3_wins_a == 3) & (prior_finish_rate_a >= 0.6)",
        hypothesis=(
            "The literal highlight-reel chase: three straight wins from a fighter who "
            "finishes 60%+ of his bouts is the most heavily clipped and circulated "
            "profile in the sport, and recency-weighted attention drives "
            "disproportionate money onto it. The finish rate is a career rate computed "
            "over few observations and regresses hard, and the streak is partly "
            "matchmaking. The model holds the career baseline, opponent-adjusted "
            "ratings and the opponent's durability against the recent run. Expect the "
            "market to be too high on the recently-finishing streaker. "
        ),
    ),
    dict(
        name="division_context__heavy_two_divisions",
        family="division_context",
        symmetric=True,
        expr_a="(weight_class == 'heavyweight') | (weight_class == 'light_heavyweight')",
        hypothesis=(
            "At 205/265 lbs a single clean strike ends the bout regardless of the "
            "accumulated skill edge, so true win probabilities are structurally "
            "compressed toward 0.50, while the book's price is anchored on record, "
            "ranking and name recognition (big men carry the most recreational handle "
            "per bout) and does not compress enough. The ensemble averages over "
            "seeds/trees and therefore shrinks its own probabilities toward 0.5 by "
            "construction, so it should give up less log-loss than the line on the "
            "confident end here. "
        ),
    ),
    dict(
        name="division_context__big_divisions_ko_threat",
        family="division_context",
        symmetric=False,
        expr_a="((weight_class == 'heavyweight') | (weight_class == 'light_heavyweight') | (weight_class == 'middleweight')) & (kd_per_fight_a >= 0.5)",
        hypothesis=(
            "A knockdown-productive fighter (>=0.5 KD/fight) in the big divisions is "
            "exactly the archetype recreational money buys - 'he only needs one' - and "
            "books shade the price toward the highlight-reel side on the bouts that get "
            "televised. The model prices knockdown production as one bounded feature "
            "alongside opponent-adjusted str_def/grap_off rather than as a narrative, "
            "so where the line is dragged toward the puncher the model's lower number "
            "on that side should win. "
        ),
    ),
    dict(
        name="division_context__big_divisions_fragile_chin",
        family="division_context",
        symmetric=False,
        expr_a="((weight_class == 'heavyweight') | (weight_class == 'light_heavyweight') | (weight_class == 'middleweight')) & (finish_against_per_bout_a >= 0.3)",
        hypothesis=(
            "Chin erosion is a slow-moving physical fact the market updates on with "
            "lag, because the fighter's win record, ranking and name survive the first "
            "two bad knockouts; in the heavy divisions, where any exchange can "
            "terminate the bout, that lag is most expensive. The model carries "
            "finish_against_per_bout and kd_absorbed_per_fight explicitly and those "
            "features have maximum leverage at this mass, so it should price the "
            "fragile side below the book. "
        ),
    ),
    dict(
        name="division_context__small_divisions",
        family="division_context",
        symmetric=True,
        expr_a="(weight_class == 'flyweight') | (weight_class == 'strawweight') | (weight_class == 'bantamweight')",
        hypothesis=(
            "Finishing power is scarcest at 115-135, so these bouts are decided on the "
            "scorecards, and a scorecard outcome is close to a deterministic function "
            "of measurable rates - output volume, control time, takedowns - which is "
            "precisely what the model measures per minute and opponent-adjusts. The "
            "soft information the book monetises (camp gossip, injury, chin, one punch) "
            "matters least where nobody gets finished, and these fights also sit on the "
            "thinnest-handle prelims, so the closing line retains more of its opening "
            "error. "
        ),
    ),
    dict(
        name="division_context__small_divisions_men_only",
        family="division_context",
        symmetric=True,
        expr_a="((weight_class == 'flyweight') | (weight_class == 'strawweight') | (weight_class == 'bantamweight')) & (is_women == 0)",
        hypothesis=(
            "Same decision-dominance mechanism as the small-division segment, but with "
            "the women's bouts stripped out, because women's flyweight/strawweight make "
            "up nearly half of the small-division pool and carry a separate thin-market "
            "story. If the model's small-division edge is really about fights going to "
            "the cards rather than about thin women's betting markets, it must survive "
            "here; if it vanishes, the small-division result was the women's-market "
            "result all along. "
        ),
    ),
    dict(
        name="division_context__light_divisions_no_knockdown_power",
        family="division_context",
        symmetric=True,
        expr_a="((weight_class == 'flyweight') | (weight_class == 'strawweight') | (weight_class == 'bantamweight') | (weight_class == 'featherweight')) & (kd_per_fight_a <= 0.2) & (kd_per_fight_b <= 0.2)",
        hypothesis=(
            "In the grouped light divisions, a bout where neither fighter has "
            "demonstrated knockdown production is a scorecard fight by construction, so "
            "the finish variance that the book prices better than any stats model is "
            "simply absent and what remains is accumulated volume, control and takedown "
            "rate - the model's strongest measured signal. This is the division-plus- "
            "finish-character version of the light-division claim, defined on a NaN- "
            "free power feature instead of on the division label alone. "
        ),
    ),
    dict(
        name="division_context__womens_bouts",
        family="division_context",
        symmetric=True,
        expr_a="is_women == 1",
        hypothesis=(
            "The women's talent pool is thin, so genuine skill gaps are larger and "
            "persist longer across bouts, which is exactly what a rating/feature model "
            "captures and what a market anchored on recent narrative under- "
            "extrapolates. Women's bouts also draw a small fraction of the handle: "
            "opening lines are set with less modelling effort and are moved by fewer "
            "sharp dollars before close, so the closing price keeps more of its initial "
            "error, while the model applies identical machinery regardless of gender. "
        ),
    ),
    dict(
        name="division_context__womens_low_ufc_experience",
        family="division_context",
        symmetric=True,
        expr_a="(is_women == 1) & (min_prior_bouts <= 6)",
        hypothesis=(
            "The thin-pool effect at its sharpest: the women's divisions are where the "
            "UFC signs the least-vetted fighters, and here at least one side has almost "
            "no UFC tape for the book to price from, so the line leans on reputation "
            "and a tiny film sample. The model additionally carries pre-UFC bouts, "
            "elo/glicko priors and vertex_score, so its information advantage over the "
            "market should be largest exactly where UFC tape is thinnest. "
        ),
    ),
    dict(
        name="division_context__five_round_bouts",
        family="division_context",
        symmetric=True,
        expr_a="scheduled_rounds == 5",
        hypothesis=(
            "Twenty-five-minute bouts are decided by cardio, pace decay and late-round "
            "durability - traj_sapm, traj_slpm, avg_bout_seconds and absorbed-damage "
            "features the model carries explicitly - whereas a five-rounder's price is "
            "dominated by the headline/champion narrative and by the recreational money "
            "that concentrates on the single televised main event, which shades the "
            "popular side. Expected direction is model better on the underdog side; "
            "this is deliberately a two-sided test, since these are also the highest- "
            "handle and therefore potentially sharpest markets in the pool. "
        ),
    ),
    dict(
        name="gap__quick_turnaround_short_notice",
        family="gap",
        symmetric=False,
        expr_a="layoff_days_a <= 100",
        hypothesis=(
            "DUPLICATE FLAGS FIRST (my critic duty): "
            "market_microstructure__five_round_headliner and "
            "division_context__five_round_bouts are the SAME expression "
            "(scheduled_rounds == 5, both n=147) and "
            "market_microstructure__womens_thin_handle and "
            "division_context__womens_bouts are the SAME expression (is_women == 1, "
            "both n=219) — each pair burns two slots of multiplicity correction for one "
            "test and should be merged; also near-duplicates: "
            "activity_layoff__layoff_after_loss vs "
            "form_momentum__long_layoff_after_loss, activity_layoff__long_layoff_400 vs "
            "market_microstructure__stale_price_returnee, "
            "experience_pedigree__hot_streak_vs_flat vs "
            "form_momentum__hot_streak_vs_skid, "
            "style_and_age__ageing_striker_vs_younger vs "
            "style_and_age__speed_matchup_ageing_striker, and "
            "division_context__small_divisions_men_only is a strict subset of "
            "division_context__small_divisions; separately, no lens proposed an ERA "
            "slice and none should — is_discovery is a time split (discovery is "
            "2016-2024, confirmation is 2025-2026 only), so any year-based segment is "
            "degenerate. THIS SEGMENT'S MECHANISM: every activity-layoff segment "
            "interrogates the long-layoff tail, and the only fresh-side segment "
            "(both_active) is symmetric, so the asymmetric quick turnaround is "
            "uncovered; a sub-100-day turnaround is almost always a short-notice "
            "booking (injury replacement or quick APEX re-book), whose line opens late, "
            "absorbs little handle before close and is set from a compressed news "
            "cycle, while the model prices the same stable career features it always "
            "does — expect the model to hold an edge on the short-notice side. "
        ),
    ),
    dict(
        name="gap__submission_threat_vs_leaky_defence",
        family="gap",
        symmetric=False,
        expr_a="(sub_per15_a >= 0.8) & (grap_def_b <= -0.35)",
        hypothesis=(
            "sub_per15 is touched by no lens in the grid, yet submissions are a "
            "distinct, heavy-tailed path to victory: a submission-active fighter facing "
            "an opponent whose opponent-adjusted grappling defence is below league mean "
            "has a real repeatable finishing route that public pricing underweights "
            "because it produces no highlight and does not enter 'who wins the rounds' "
            "reasoning. The model reads the rate and the defensive deficit directly, so "
            "expect it to sit above the line on the submission threat. "
        ),
    ),
    dict(
        name="gap__american_vs_international",
        family="gap",
        symmetric=False,
        expr_a="(is_american_a == 1) & (is_american_b == 0) & (min_prior_bouts >= 4)",
        hypothesis=(
            "is_american is unused by all eight lenses despite being the cleanest "
            "sentiment axis in the frame: US-facing books take predominantly domestic "
            "public money and shade the number to balance action, so the American side "
            "closes systematically a tick short of its true price. Requiring "
            "min_prior_bouts >= 4 makes this disjoint from "
            "market_microstructure__thin_prelim_market (measured overlap exactly 0) so "
            "it isolates the nationality-handle effect from the no-data-on-this-fighter "
            "effect; expect the model to be higher than the market on the non-American "
            "side. "
        ),
    ),
    dict(
        name="gap__small_division_veteran",
        family="gap",
        symmetric=False,
        expr_a="((weight_class == 'flyweight') | (weight_class == 'strawweight') | (weight_class == 'bantamweight')) & (age_a >= 33)",
        hypothesis=(
            "Division crossed with age, which neither the division-context nor the "
            "style-and-age lens could see alone: wins in the three smallest divisions "
            "are bought with speed, volume and cardio rather than power, so the decline "
            "that begins around 33 costs a flyweight far more than it costs a "
            "heavyweight, while the market applies one generic veteran discount across "
            "the whole roster. The model's rate and trajectory features (traj_slpm, "
            "traj_sapm, output) measure the decay in the units of the actual win path "
            "here, so expect the model to be lower than the line on the 33+ side. "
        ),
    ),
    dict(
        name="gap__elo_gap_at_flat_price",
        family="gap",
        symmetric=True,
        expr_a="(elo_gap >= 35) & (market_conf < 0.66)",
        hypothesis=(
            "elo_gap is used by zero lenses; this crosses the ratings/pedigree lens "
            "with the price lens to isolate bouts where rating history says there is a "
            "real class gap but the close says near-coinflip. Normally the price wins "
            "that argument because it carries soft information (camp, injury, weight "
            "cut) ratings cannot see, but in low-profile bouts there is no soft "
            "information to carry and a flat price is a default rather than a "
            "judgement, so expect the model to be sharper than the market on the "
            "higher-rated fighter. Overlap with the existing coinflip_band is only 43% "
            "and with moderate_favourite_band 31%, so it is a genuine interaction and "
            "not a band re-slice. "
        ),
    ),
    dict(
        name="gap__grappler_at_pickem_price",
        family="gap",
        symmetric=False,
        expr_a="(is_grappler_a == 1) & (market_conf < 0.64)",
        hypothesis=(
            "Style crossed with market confidence — the interaction the style lens and "
            "the microstructure lens each could only half-see. A pick'em price means "
            "the market has run out of ways to separate the two on perceived quality, "
            "which is exactly the regime where structural matchup facts carry maximum "
            "relative weight, and grappling is the least visible of them (it wins "
            "decisions without producing highlights, so public pricing chronically "
            "underweights it). Expect the model's grappling-axis features to beat the "
            "price on the grappler's side specifically when the line is flat, an effect "
            "invisible to a whole-population grappler segment. "
        ),
    ),
    dict(
        name="gap__decision_bound_bout",
        family="gap",
        symmetric=True,
        expr_a="(distance_share_a >= 0.70) & (distance_share_b >= 0.70) & (kd_per_fight_a <= 0.25) & (kd_per_fight_b <= 0.25)",
        hypothesis=(
            "Two distance-bound fighters with almost no knockdown production means the "
            "bout will very likely be scored rather than finished, and judging injects "
            "a large noise layer that compresses true win probability toward 0.5 — but "
            "books price the perceived skill gap, not the variance of the resolution "
            "mechanism, so lopsided-looking pairings of this shape close too "
            "confidently. A model fit on realized outcomes has that decision noise "
            "baked into its calibration, so expect it to win on log-loss by being less "
            "confident here; measured overlap with both_iron_chins is only 23%, so this "
            "tests the resolution mechanism rather than durability. "
        ),
    ),
    dict(
        name="gap__reach_edge_vs_wrestler",
        family="gap",
        symmetric=False,
        expr_a="((reach_a - reach_b) >= 6) & (td_per15_b >= 1.2)",
        hypothesis=(
            "The physical-durability lens crossed reach only with striking skill, "
            "treating length as an unconditional asset; nobody tested reach against the "
            "opponent's takedown volume, where it is partly a liability — long levers "
            "are easier to duck-under and shoot on, and the reach edge is worth nothing "
            "once the fight is on the mat. The market prices 'he is much longer' as a "
            "plus in every context because it is the most legible physical fact on the "
            "tale of the tape, while the model conditions it on the opponent's takedown "
            "rate, so expect the model to sit below the line on the long-reach side. "
        ),
    ),
    dict(
        name="post_hoc__we_back_the_favourite",
        family="post_hoc",
        symmetric=True,
        expr_a="lean_fav >= 0.05",
        hypothesis=(
            "POST-HOC, not pre-registered: found by inspecting the lean table, so it "
            "does not carry the same guarantee as the 86 above. The model is under- "
            "dispersed toward the favourite — on average it gives the book's favourite "
            "6.4 pp LESS than the book does. Where it nevertheless gives that favourite "
            "MORE, the deviation is against the model's own bias and should therefore "
            "be informative. "
        ),
    ),
    dict(
        name="post_hoc__we_back_the_favourite_hard",
        family="post_hoc",
        symmetric=True,
        expr_a="lean_fav >= 0.10",
        hypothesis=(
            "POST-HOC. The stricter form of the same rule. "
        ),
    ),
    dict(
        name="post_hoc__we_fade_the_favourite_hard",
        family="post_hoc",
        symmetric=True,
        expr_a="lean_fav <= -0.10",
        hypothesis=(
            "POST-HOC, and the control that makes the one above meaningful: the same "
            "disagreement magnitude in the direction the model is already biased. If "
            "both sides pay, the rule is about disagreement size; if only one pays, it "
            "is about direction. "
        ),
    ),
]
