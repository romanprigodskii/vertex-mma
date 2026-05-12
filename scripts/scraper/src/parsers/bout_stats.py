from __future__ import annotations

import re
from dataclasses import dataclass

from selectolax.parser import HTMLParser, Node

from ..utils.dates import parse_round_time
from ..utils.measures import parse_int, parse_landed_of

_FIGHTER_ID_RE = re.compile(r"/fighter-details/([a-z0-9]+)")


@dataclass
class FighterRoundStats:
    fighter_ufc_id: str
    round: int

    sig_str_landed: int = 0
    sig_str_attempted: int = 0
    sig_str_head_landed: int = 0
    sig_str_head_attempted: int = 0
    sig_str_body_landed: int = 0
    sig_str_body_attempted: int = 0
    sig_str_legs_landed: int = 0
    sig_str_legs_attempted: int = 0
    sig_str_distance_landed: int = 0
    sig_str_clinch_landed: int = 0
    sig_str_ground_landed: int = 0
    total_str_landed: int = 0
    total_str_attempted: int = 0

    takedowns_landed: int = 0
    takedowns_attempted: int = 0
    sub_attempts: int = 0
    reversals: int = 0
    control_time_seconds: int = 0

    knockdowns: int = 0


def _two_text(cell: Node) -> list[str]:
    return [p.text(strip=True) for p in cell.css("p.b-fight-details__table-text")]


def _split_rounds_table(table: Node) -> list[tuple[int, Node]]:
    """Walk a per-round table and return [(round_number, tr_row_node)] pairs.

    UFCStats writes invalid HTML — `<thead>...Round N</thead>` appears inside
    `<tbody>`, which the HTML5 parser reparents out: each Round-N thead becomes
    a direct child of the table, immediately followed by an auto-generated tbody
    containing that round's data row. We walk table children in document order,
    track the most recent Round-N marker, and collect tr's from the tbodys that
    follow it.
    """
    rounds: list[tuple[int, Node]] = []
    current_round = 0

    for child in table.iter():
        tag = child.tag
        if tag == "thead":
            # Round-N markers have a single <th colspan="10">; column headers have many <th>s.
            th = child.css_first("th.b-fight-details__table-col[colspan]")
            if th is None:
                continue
            m = re.search(r"Round\s*(\d+)", th.text(strip=True))
            if m:
                current_round = int(m.group(1))
        elif tag == "tbody" and current_round > 0:
            for tr in child.iter():
                if tr.tag == "tr":
                    rounds.append((current_round, tr))
    return rounds


def parse_bout_round_stats(html: str) -> list[FighterRoundStats]:
    """Parse the two per-round tables on a /fight-details/ page.

    Returns one FighterRoundStats per (round, fighter). Missing fields stay zero.
    Returns an empty list when the page has no round-by-round data (older fights).
    """
    tree = HTMLParser(html)
    tables = tree.css("table.b-fight-details__table.js-fight-table")
    if not tables:
        return []

    # Skip the leading "Totals" sections. The two per-round tables sit under the
    # "Per round" toggle. We can identify them as the ones whose preceding sibling
    # contains "Per round" text, but the simpler heuristic is: there are typically
    # four tables (totals strikes, per-round strikes, totals strike-detail, per-round
    # strike-detail). The per-round ones have <thead> rows with "Round N".
    per_round_tables: list[Node] = [t for t in tables if t.css_first("thead.b-fight-details__table-row_type_head, thead.b-fight-details__table-row.b-fight-details__table-row_type_head")]
    if not per_round_tables:
        # Fallback: try parsing every table and keep only those with Round N markers.
        for t in tables:
            for thead in t.css("thead"):
                if "Round" in thead.text(strip=True):
                    per_round_tables.append(t)
                    break
    if len(per_round_tables) < 2:
        return []

    table_main = per_round_tables[0]
    table_strikes = per_round_tables[1] if len(per_round_tables) >= 2 else None

    # Per (round, fighter) accumulator.
    out: dict[tuple[int, str], FighterRoundStats] = {}

    def get(round_no: int, fid: str) -> FighterRoundStats:
        key = (round_no, fid)
        if key not in out:
            out[key] = FighterRoundStats(fighter_ufc_id=fid, round=round_no)
        return out[key]

    # Table 1 columns:
    # 0: Fighter (2 links)
    # 1: KD (2 ints)
    # 2: Sig. str. (2 "X of Y")
    # 3: Sig. str. % (2 "X%")
    # 4: Total str. (2 "X of Y")
    # 5: Td (2 "X of Y")
    # 6: Td % (2 "X%")
    # 7: Sub. att (2 ints)
    # 8: Rev. (2 ints)
    # 9: Ctrl (2 "M:SS")
    for round_no, row in _split_rounds_table(table_main):
        cells = row.css("td.b-fight-details__table-col")
        if len(cells) < 10:
            continue

        fighter_links = cells[0].css("a")
        if len(fighter_links) < 2:
            continue
        fid_a_m = _FIGHTER_ID_RE.search(fighter_links[0].attributes.get("href") or "")
        fid_b_m = _FIGHTER_ID_RE.search(fighter_links[1].attributes.get("href") or "")
        if not fid_a_m or not fid_b_m:
            continue
        fids = [fid_a_m.group(1), fid_b_m.group(1)]

        for side, fid in enumerate(fids):
            stats = get(round_no, fid)

            kd_vals = _two_text(cells[1])
            stats.knockdowns = parse_int(kd_vals[side] if side < len(kd_vals) else "") or 0

            sig_vals = _two_text(cells[2])
            sl, sa = parse_landed_of(sig_vals[side] if side < len(sig_vals) else "")
            stats.sig_str_landed = sl or 0
            stats.sig_str_attempted = sa or 0

            total_vals = _two_text(cells[4])
            tl, ta = parse_landed_of(total_vals[side] if side < len(total_vals) else "")
            stats.total_str_landed = tl or 0
            stats.total_str_attempted = ta or 0

            td_vals = _two_text(cells[5])
            tdl, tda = parse_landed_of(td_vals[side] if side < len(td_vals) else "")
            stats.takedowns_landed = tdl or 0
            stats.takedowns_attempted = tda or 0

            sub_vals = _two_text(cells[7])
            stats.sub_attempts = parse_int(sub_vals[side] if side < len(sub_vals) else "") or 0

            rev_vals = _two_text(cells[8])
            stats.reversals = parse_int(rev_vals[side] if side < len(rev_vals) else "") or 0

            ctrl_vals = _two_text(cells[9])
            stats.control_time_seconds = parse_round_time(ctrl_vals[side] if side < len(ctrl_vals) else "") or 0

    # Table 2 columns (significant strikes detail):
    # 0: Fighter (2 links)
    # 1: Sig. str. (2 "X of Y") — redundant with table 1
    # 2: Sig. str. % (2 "X%") — skip
    # 3: Head (2 "X of Y")
    # 4: Body (2 "X of Y")
    # 5: Leg (2 "X of Y")
    # 6: Distance (2 "X of Y")
    # 7: Clinch (2 "X of Y")
    # 8: Ground (2 "X of Y")
    if table_strikes is not None:
        for round_no, row in _split_rounds_table(table_strikes):
            cells = row.css("td.b-fight-details__table-col")
            if len(cells) < 9:
                continue

            fighter_links = cells[0].css("a")
            if len(fighter_links) < 2:
                continue
            fid_a_m = _FIGHTER_ID_RE.search(fighter_links[0].attributes.get("href") or "")
            fid_b_m = _FIGHTER_ID_RE.search(fighter_links[1].attributes.get("href") or "")
            if not fid_a_m or not fid_b_m:
                continue
            fids = [fid_a_m.group(1), fid_b_m.group(1)]

            for side, fid in enumerate(fids):
                stats = get(round_no, fid)

                head_vals = _two_text(cells[3])
                hl, ha = parse_landed_of(head_vals[side] if side < len(head_vals) else "")
                stats.sig_str_head_landed = hl or 0
                stats.sig_str_head_attempted = ha or 0

                body_vals = _two_text(cells[4])
                bl, ba = parse_landed_of(body_vals[side] if side < len(body_vals) else "")
                stats.sig_str_body_landed = bl or 0
                stats.sig_str_body_attempted = ba or 0

                leg_vals = _two_text(cells[5])
                ll, la = parse_landed_of(leg_vals[side] if side < len(leg_vals) else "")
                stats.sig_str_legs_landed = ll or 0
                stats.sig_str_legs_attempted = la or 0

                dist_vals = _two_text(cells[6])
                dl, _da = parse_landed_of(dist_vals[side] if side < len(dist_vals) else "")
                stats.sig_str_distance_landed = dl or 0

                clinch_vals = _two_text(cells[7])
                cl, _ca = parse_landed_of(clinch_vals[side] if side < len(clinch_vals) else "")
                stats.sig_str_clinch_landed = cl or 0

                ground_vals = _two_text(cells[8])
                gl, _ga = parse_landed_of(ground_vals[side] if side < len(ground_vals) else "")
                stats.sig_str_ground_landed = gl or 0

    return list(out.values())
