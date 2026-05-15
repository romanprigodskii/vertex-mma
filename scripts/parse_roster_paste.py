#!/usr/bin/env python3
"""Parse a roster.watch table paste into a CSV snapshot.

The paste is the tab-separated content copied from https://www.roster.watch/
(any number of pages concatenated). One fighter spans multiple paste lines
because some HTML cells are multi-line internally (wins breakdown, losses
breakdown, debut/prev/next bout opponents).

Usage:
    python scripts/parse_roster_paste.py [input_path] [output_path]
    Defaults: imports/roster_paste.txt -> imports/roster_snapshot.csv
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

FLAG_RE = re.compile(
    r'[\U0001F1E6-\U0001F1FF][\U0001F1E6-\U0001F1FF]'
    r'|\U0001F3F4(?:[\U000E0020-\U000E007F]+\U000E007F)?'
    r'|\U0001F3F4‍☠️'
)
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
BIRTHDATE_RE = re.compile(r'^\(\d{4}-\d{2}-\d{2}\)$')
NUMBER_RE = re.compile(r'^-?\d+(?:\.\d+)?$')
GENDER_RE = re.compile(r'^[♀♂]')
RESULT_PREFIX_RE = re.compile(r'^(?:W|L|D|NC)\s-\s')
WINS_BREAKDOWN_RE = re.compile(r'^\d+\s+KO\s+\d+\s+Sub\s+\d+\s+Dec$')
CHANGE_PREFIX_RE = re.compile(r'^([▲▼]\d|NEW|OUT)(.*)$')

KNOWN_BADGES = ['CS', '𝙏𝙐𝙁', 'HoF', '🅂🄵', '🅑🅜🅕', '𝙍𝟮𝙐', '𝖂𝕰𝕮']

CSV_FIELDS = [
    'name', 'badges', 'countries',
    'age', 'birthdate',
    'gender', 'weight_class',
    'rank', 'peak_rank', 'p4p', 'peak_p4p',
    'bouts_total', 'wins', 'wins_breakdown',
    'losses', 'losses_breakdown',
    'cur_streak', 'best_streak', 'bonus_count', 'slot',
    'elo_current', 'elo_peak', 'elo_opp',
    'debut_date', 'debut_opp',
    'prev_date', 'prev_opp',
    'next_date', 'next_opp',
]

# Data columns from the paste (after fighter, country, age, gender, weight class):
# rank, peak_rank, p4p, peak_p4p, bouts, wins, losses, cur, best, bonus, slot,
# elo_curr, elo_peak, elo_opp, debut_date, prev_date, next_date
DATA_COLS = [
    'rank', 'peak_rank', 'p4p', 'peak_p4p',
    'bouts_total', 'wins', 'losses',
    'cur_streak', 'best_streak', 'bonus_count', 'slot',
    'elo_current', 'elo_peak', 'elo_opp',
    'debut_date', 'prev_date', 'next_date',
]


def empty_record() -> dict[str, str]:
    return {f: '' for f in CSV_FIELDS}


def split_tabs(line: str) -> list[str]:
    """Split on tabs, keep empty fields."""
    return line.rstrip('\n\r').split('\t')


def is_header_line(line: str) -> bool:
    s = line.strip().lower()
    if not s:
        return False
    if 'rankings' in s and 'record' in s and 'streaks' in s:
        return True
    if s.startswith('fighter') and 'country' in s and 'age' in s and 'gender' in s:
        return True
    return False


def is_filter_widget(line: str) -> bool:
    """The roster.watch filter widget gets included if user copies the full page."""
    return len(FLAG_RE.findall(line)) > 15


def is_footer_line(line: str) -> bool:
    s = line.strip()
    return (
        s.startswith(('Updated:', 'Copyright', 'GlossaryContact', 'Glossary'))
        or s in ('logo', 'Current Roster', 'Former Roster', 'Weight Classes',
                 'Events', 'Predict', 'Log', 'Fight Log', 'AI Judge', 'Support')
    )


def is_pagination_line(line: str) -> bool:
    s = line.strip()
    if not s:
        return False
    # Things like "1-100 of 636 rows", "Previous", "Next", page numbers
    if re.match(r'^\d+-\d+\s+of\s+\d+\s+rows', s):
        return True
    if s in ('Previous', 'Next'):
        return True
    if re.match(r'^\d+$', s) and len(s) <= 2:
        # Single page number; ambiguous with rank, so only consider if very short.
        # Be careful: don't filter rank values. We only filter pagination if line
        # has just a digit AND no surrounding fighter context. Let the main loop handle.
        return False
    return False


KNOWN_RANK_TOKENS = {'C', 'IC', 'NEW', 'OUT'}


def is_name_start_line(line: str) -> bool:
    """A line that could be the first line of a new fighter record."""
    s = line.rstrip()
    if not s.strip():
        return False
    if is_header_line(line) or is_filter_widget(line) or is_footer_line(line):
        return False
    first = s.split('\t')[0].strip()
    if not first:
        return False
    if not first[0].isalpha() and not (first[0] == ' ' and len(first) > 1 and first.strip()[0].isalpha()):
        return False
    if first in KNOWN_RANK_TOKENS:
        return False
    if re.match(r'^[▲▼]', first):
        return False
    if first.startswith(('W -', 'L -', 'D -', 'NC -')):
        return False
    if first.startswith(('♂', '♀')):
        return False
    if WINS_BREAKDOWN_RE.match(first):
        return False
    if BIRTHDATE_RE.match(first):
        return False
    return True


def extract_name_badges(s: str) -> tuple[str, str]:
    name = s.strip()
    badges: list[str] = []
    changed = True
    while changed:
        changed = False
        for b in KNOWN_BADGES:
            if name.endswith(' ' + b):
                badges.insert(0, b)
                name = name[:-(len(b) + 1)].rstrip()
                changed = True
                break
    return name, ','.join(badges)


def strip_change_prefix(s: str) -> tuple[str, str]:
    """Split '▲3C' -> ('▲3', 'C'), 'NEW7' -> ('NEW', '7'), 'OUT' -> ('OUT', '')."""
    if not s:
        return '', ''
    m = CHANGE_PREFIX_RE.match(s)
    if m:
        return m.group(1), m.group(2)
    return '', s


def parse_rank_line(rec: dict, fields: list[str]) -> None:
    """6-field rank line: rank, peak, p4p (with optional change prefix), peak_p4p, bouts, wins."""
    if len(fields) < 4:
        return
    # Field 0: rank (possibly with change prefix)
    _, rank_val = strip_change_prefix(fields[0])
    rec['rank'] = rank_val or fields[0]
    rec['peak_rank'] = fields[1]
    # Field 2: p4p (possibly with change prefix, OUT, or NEW)
    p4p_pre, p4p_val = strip_change_prefix(fields[2])
    if p4p_pre == 'OUT':
        rec['p4p'] = ''  # OUT = no longer in p4p
    else:
        rec['p4p'] = p4p_val or fields[2]
    if len(fields) > 3:
        rec['peak_p4p'] = fields[3]
    if len(fields) > 4:
        rec['bouts_total'] = fields[4]
    if len(fields) > 5:
        rec['wins'] = fields[5]


def parse_birthdate_line(rec: dict, fields: list[str]) -> None:
    """Parse the (birthdate) line, which may include extra trailing data when
    rank/peak/p4p cells are empty."""
    if not fields:
        return
    if BIRTHDATE_RE.match(fields[0]):
        rec['birthdate'] = fields[0][1:-1]
    if len(fields) > 1 and GENDER_RE.match(fields[1]):
        rec['gender'] = 'M' if fields[1].startswith('♂') else 'F'
    if len(fields) > 2:
        rec['weight_class'] = fields[2]
    # Fields 3+ map to data columns (rank, peak, p4p, peak_p4p, bouts, wins, ...)
    for j, val in enumerate(fields[3:]):
        if j < len(DATA_COLS):
            key = DATA_COLS[j]
            # Handle change-prefix in rank/p4p positions
            if key in ('rank', 'p4p'):
                pre, v = strip_change_prefix(val)
                if pre == 'OUT':
                    rec[key] = ''
                else:
                    rec[key] = v or val
            else:
                rec[key] = val


def parse_stats_line(rec: dict, fields: list[str]) -> None:
    """losses_breakdown + cur + best + bonus + slot + elo_curr + elo_peak + elo_opp + debut_date."""
    if not fields:
        return
    if WINS_BREAKDOWN_RE.match(fields[0]):
        rec['losses_breakdown'] = fields[0]
    stats_keys = ['cur_streak', 'best_streak', 'bonus_count', 'slot',
                  'elo_current', 'elo_peak', 'elo_opp', 'debut_date']
    for k, v in zip(stats_keys, fields[1:]):
        rec[k] = v


def parse_wins_breakdown_line(rec: dict, fields: list[str]) -> None:
    """wins_breakdown + losses_count."""
    if fields and WINS_BREAKDOWN_RE.match(fields[0]):
        rec['wins_breakdown'] = fields[0]
    if len(fields) > 1:
        rec['losses'] = fields[1]


def parse_debut_opp_line(rec: dict, fields: list[str]) -> None:
    """debut_opp + prev_date."""
    if fields and RESULT_PREFIX_RE.match(fields[0]):
        rec['debut_opp'] = fields[0]
    if len(fields) > 1 and DATE_RE.match(fields[1]):
        rec['prev_date'] = fields[1]


def parse_prev_opp_line(rec: dict, fields: list[str]) -> None:
    """prev_opp + (optional) next_date."""
    if fields and RESULT_PREFIX_RE.match(fields[0]):
        rec['prev_opp'] = fields[0]
    if len(fields) > 1 and DATE_RE.match(fields[1]):
        rec['next_date'] = fields[1]


def parse_one_fighter(lines: list[str], start: int) -> tuple[dict, int]:
    """Parse one fighter starting at lines[start]. Return (record, lines_consumed)."""
    rec = empty_record()
    i = start
    n = len(lines)

    # --- Parse name line ---
    fields = split_tabs(lines[i])
    name_field = fields[0]
    rec['name'], rec['badges'] = extract_name_badges(name_field)
    # Process trailing fields on name line (could be flags + age)
    for f in fields[1:]:
        f = f.strip()
        if FLAG_RE.fullmatch(f):
            rec['countries'] += f
        elif re.match(r'^\d+$', f) and 15 <= int(f) <= 70:
            rec['age'] = f
    i += 1

    # --- Continue absorbing flag-only / flag+age lines until age found ---
    while not rec['age'] and i < n:
        fields = split_tabs(lines[i])
        # Stop if this line doesn't look like a flag continuation
        any_flag = any(FLAG_RE.fullmatch(f.strip()) for f in fields)
        any_age = any(re.match(r'^\d+$', f.strip()) and 15 <= int(f.strip()) <= 70 for f in fields)
        if not any_flag and not any_age:
            break
        for f in fields:
            f = f.strip()
            if FLAG_RE.fullmatch(f):
                rec['countries'] += f
            elif re.match(r'^\d+$', f) and 15 <= int(f) <= 70:
                rec['age'] = f
        i += 1

    # --- Parse remaining lines ---
    # State: have we seen the birthdate? Set rank line parsed? etc.
    saw_wins_breakdown = False

    while i < n:
        line = lines[i]
        s = line.rstrip()
        stripped = s.strip()

        if not stripped:
            i += 1
            continue

        if is_header_line(line) or is_filter_widget(line) or is_footer_line(line):
            i += 1
            continue

        # Stop if this is a new fighter (and we're not expecting a next_opp)
        if is_name_start_line(line) and rec['birthdate']:
            # If we still need a next_opp (because next_date was set), consume this line
            if rec['next_date'] and not rec['next_opp']:
                rec['next_opp'] = stripped.split('\t')[0].strip()
                i += 1
            break

        fields = split_tabs(line)
        first = fields[0].strip()

        # Birthdate line (and possibly with embedded rank/bouts)
        if BIRTHDATE_RE.match(first):
            parse_birthdate_line(rec, fields)
            i += 1
            continue

        # Wins/losses breakdown
        if WINS_BREAKDOWN_RE.match(first):
            if not saw_wins_breakdown:
                parse_wins_breakdown_line(rec, fields)
                saw_wins_breakdown = True
            else:
                parse_stats_line(rec, fields)
            i += 1
            continue

        # Debut / prev opp line
        if RESULT_PREFIX_RE.match(first):
            if not rec['debut_opp']:
                parse_debut_opp_line(rec, fields)
            elif not rec['prev_opp']:
                parse_prev_opp_line(rec, fields)
            i += 1
            continue

        # Could be: rank line (4-6 fields, rank-like content)
        # Or: 0-bout fighter's stand-alone data line (many fields with empties)
        # Or: just the next_opp (a name without prefix)
        is_rank_first = (
            first in ('C', 'IC', 'OUT', 'NEW') or
            re.match(r'^\d+$', first) or
            re.match(r'^[▲▼]', first)
        )

        def is_rank_like_field(f: str) -> bool:
            f = f.strip()
            if not f:
                return False
            if f in KNOWN_RANK_TOKENS:
                return True
            if re.match(r'^[▲▼]', f):
                return True
            if re.match(r'^-?\d+(\.\d+)?$', f):
                return True
            return False

        looks_like_rank_line_with_empty_rank = (
            not first and len(fields) >= 4 and len(fields) <= 9 and
            sum(1 for f in fields if is_rank_like_field(f)) >= 2 and
            all(is_rank_like_field(f) or not f.strip() for f in fields)
        )

        # Detect 0-bout sparse line: starts with empty field and has many fields with elos
        if not first and len(fields) >= 10:
            # Map fields positionally to data columns starting at rank
            for j, val in enumerate(fields):
                if j < len(DATA_COLS):
                    key = DATA_COLS[j]
                    if key in ('rank', 'p4p'):
                        pre, v = strip_change_prefix(val)
                        if pre == 'OUT':
                            rec[key] = ''
                        else:
                            rec[key] = v or val
                    else:
                        rec[key] = val
            i += 1
            continue

        if (is_rank_first or looks_like_rank_line_with_empty_rank) and len(fields) >= 4:
            parse_rank_line(rec, fields)
            i += 1
            continue

        # Otherwise, if rec has prev_date set + needs next_opp
        if rec['next_date'] and not rec['next_opp']:
            rec['next_opp'] = first
            i += 1
            break

        # Unknown line — skip
        i += 1

    return rec, i - start


def parse_paste(text: str) -> list[dict]:
    lines = text.split('\n')
    fighters: list[dict] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if is_header_line(line) or is_filter_widget(line) or is_footer_line(line):
            i += 1
            continue
        if is_name_start_line(line):
            rec, consumed = parse_one_fighter(lines, i)
            if rec['name']:
                fighters.append(rec)
            i += max(consumed, 1)
        else:
            i += 1
    return fighters


def main() -> None:
    in_path = Path(sys.argv[1] if len(sys.argv) > 1 else 'imports/roster_paste.txt')
    out_path = Path(sys.argv[2] if len(sys.argv) > 2 else 'imports/roster_snapshot.csv')

    raw = in_path.read_text(encoding='utf-8')
    parsed = parse_paste(raw)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for rec in parsed:
            w.writerow(rec)

    print(f'Parsed {len(parsed)} fighter records')
    print(f'Wrote {out_path}')

    champs = [r for r in parsed if r['rank'] == 'C']
    print(f'\n=== Active champions ({len(champs)}) ===')
    for r in champs:
        print(f'  {r["name"]:35s} | {r["weight_class"]} | peak_p4p={r["peak_p4p"]} | next: {r["next_date"]} {r["next_opp"]}')

    ics = [r for r in parsed if r['rank'] == 'IC']
    print(f'\n=== Interim champions ({len(ics)}) ===')
    for r in ics:
        print(f'  {r["name"]:35s} | {r["weight_class"]}')

    with_next = [r for r in parsed if r['next_date']]
    print(f'\n=== Upcoming bouts ({len(with_next)}) ===')
    for r in with_next[:10]:
        print(f'  {r["next_date"]}  {r["name"]:30s} vs {r["next_opp"]}')

    zero_bouts = [r for r in parsed if r['bouts_total'] == '0']
    print(f'\n=== Zero UFC bouts ({len(zero_bouts)}) ===')
    for r in zero_bouts[:10]:
        print(f'  {r["name"]:35s} | next: {r["next_date"] or "—"} {r["next_opp"] or ""}')

    # Sanity: known fighters
    by_name = {r['name']: r for r in parsed}
    print('\n=== Sanity spot-check ===')
    for nm in ['Islam Makhachev', 'Ilia Topuria', 'Alex Pereira', 'Khamzat Chimaev',
               'Carlos Ulberg', 'Sean Strickland', 'Tom Aspinall', 'Magomed Ankalaev',
               'Aaron Pico', 'Jingnan Xiong', 'Louis Lee Scott']:
        r = by_name.get(nm)
        if not r:
            print(f'  ❌ {nm}: NOT FOUND')
            continue
        print(f'  {nm:30s} rank={r["rank"]:>4s} p4p={r["p4p"]:>3s} '
              f'W-L={r["wins"] or "?"}-{r["losses"] or "?"} '
              f'elo={r["elo_current"]} next={r["next_date"]} {r["next_opp"]}')

    no_birth = [r for r in parsed if not r['birthdate']]
    if no_birth:
        print(f'\n!!! {len(no_birth)} fighters without parsed birthdate')
        for r in no_birth[:5]:
            print(f'  {r["name"]}')


if __name__ == '__main__':
    main()
