"""Wave 2.6 — backfill `fighter.country_code` for all fighters.

UFCStats does NOT expose nationality on its fighter-detail pages (verified
against Khabib, Conor, Aalon Cruz — zero mentions of country/birthplace/born).
Source of truth here is Wikipedia/Wikidata:

  fighter.name_en
    → Wikipedia article title (opensearch + disambiguator suffix fallback)
    → Wikidata entity via `wbgetentities?sites=enwiki&titles=…`
    → P27 (country of citizenship) claim, highest-rank value
    → ISO 3166-1 alpha-2 via `WIKIDATA_COUNTRY_TO_ISO`

Idempotent: only fighters with `country_code IS NULL AND ufc_stats_id IS NOT NULL`
are touched, and we checkpoint by slug so re-runs skip already-attempted rows.

Champions: automatic name matching has known gaps (Tom Aspinall, for example, is
currently `photo_fetch_status = 'no_match'` despite having a clear Wikipedia
article). For the current UFC champion list we hard-code the Wikipedia title to
bypass the search step. Verified against DB on 2026-05-13.

Usage:

  pnpm scrape:country -- --dry-run --limit 5
  pnpm scrape:country               # full run, no flags
"""

from __future__ import annotations

import argparse
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import _path  # noqa: F401

# Install DNS override BEFORE importing anything that opens sockets — same
# reason as photo_scraper/scripts/fetch_photos.py.
from src.dns_override import install as install_dns_override

install_dns_override()

import httpx
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from src.db import get_connection
from src.utils.logger import log
from src.wikidata import (
    WIKIDATA_COUNTRY_TO_ISO,
    country_for_wiki_title,
    find_article_title,
)


# Wikimedia requires a contact-bearing UA for API access. Without it Wikidata
# returns 403 with a robot-policy notice (verified during development).
USER_AGENT = (
    "VertexMMA-CountryBackfill/0.1 (https://vertexmma.com; contact@vertexmma.com)"
)

RATE_LIMIT_SECONDS = 1.0
REQUEST_TIMEOUT = 30.0
CHECKPOINT_EVERY = 50

CHECKPOINT_PATH = Path(__file__).resolve().parents[1] / ".checkpoint_country.json"


# Current UFC champions (May 2026). Slugs verified against the production
# fighter table on 2026-05-13 — see the resolution step in commit message.
# Use the slug as the override key so we can sanity-check the DB row before
# trusting the override, and so re-imports that change the slug surface as
# misses (loud rather than silent wrong-fighter mappings).
CHAMPION_TITLE_OVERRIDES: dict[str, str] = {
    "tom-aspinall-399afb": "Tom Aspinall",
    "alex-pereira-e5549c": "Alex Pereira",
    "khamzat-chimaev-767755": "Khamzat Chimaev",
    "islam-makhachev-275aca": "Islam Makhachev",
    "ilia-topuria-54f64b": "Ilia Topuria",
    "alexander-volkanovski-e12489": "Alexander Volkanovski",
    "petr-yan-d661ce": "Petr Yan",
    "joshua-van-17e976": "Joshua Van",
    "mackenzie-dern-7447e9": "Mackenzie Dern",
    "valentina-shevchenko-132deb": "Valentina Shevchenko",
    "zhang-weili-1ebe20": "Zhang Weili",
    "justin-gaethje-9e8f6c": "Justin Gaethje",
}


@dataclass
class Outcome:
    slug: str
    name: str
    iso: str | None
    reason: str
    via_override: bool


# ---------------------------------------------------------------------------
# HTTP client (per-thread, rate-limited)
# ---------------------------------------------------------------------------

import time


class _RetryableHTTPError(Exception):
    pass


class RateLimitedClient:
    """Thin wrapper around `httpx.Client` with self-throttling and 429/5xx retry.

    One instance per worker thread — `httpx.Client` is thread-safe, but the
    throttling cursor isn't shared across workers by design (the user spec is
    "1 s/req, 4 workers" → ~4 req/s aggregate, which is well within Wikimedia
    policy for a properly-identified bot).
    """

    def __init__(self) -> None:
        self._client = httpx.Client(
            timeout=REQUEST_TIMEOUT,
            headers={
                "User-Agent": USER_AGENT,
                "Accept-Language": "en-US,en;q=0.9",
            },
            follow_redirects=True,
            http2=True,
        )
        self._rate_limit = RATE_LIMIT_SECONDS
        self._last_ts = 0.0

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "RateLimitedClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _throttle(self) -> None:
        delta = time.monotonic() - self._last_ts
        if delta < self._rate_limit:
            time.sleep(self._rate_limit - delta)
        self._last_ts = time.monotonic()

    @retry(
        retry=retry_if_exception_type(_RetryableHTTPError),
        stop=stop_after_attempt(6),
        wait=wait_exponential(multiplier=2, min=2, max=60),
        reraise=True,
    )
    def get(self, url: str, *, params: dict | None = None) -> httpx.Response:
        self._throttle()
        try:
            response = self._client.get(url, params=params)
        except httpx.HTTPError as exc:
            raise _RetryableHTTPError(repr(exc)) from exc
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("retry-after")
            log.warning(
                f"GET {url} -> {response.status_code} retry-after={retry_after} — will retry"
            )
            if retry_after:
                try:
                    time.sleep(min(60.0, float(retry_after)))
                except ValueError:
                    pass
            raise _RetryableHTTPError(f"status {response.status_code}")
        return response


# ---------------------------------------------------------------------------
# Checkpoint
# ---------------------------------------------------------------------------


def _load_checkpoint() -> set[str]:
    if not CHECKPOINT_PATH.exists():
        return set()
    try:
        return set(json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8")))
    except Exception:
        return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)), encoding="utf-8")


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------


def _select_targets(conn, limit: int | None) -> list[dict]:
    """Fighters missing country, ordered by bout count (popular first)."""
    with conn.cursor() as cur:
        sql = """
            SELECT
                f.id::text AS id,
                f.slug,
                f.name_en,
                f.nickname,
                (
                    SELECT COUNT(*) FROM bout b
                    WHERE b.fighter_a_id = f.id OR b.fighter_b_id = f.id
                ) AS bout_count
            FROM fighter f
            WHERE f.country_code IS NULL
              AND f.ufc_stats_id IS NOT NULL
            ORDER BY bout_count DESC, f.name_en ASC
        """
        if limit is not None:
            sql += " LIMIT %s"
            cur.execute(sql, (limit,))
        else:
            cur.execute(sql)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]


def _update_country(conn, fighter_id: str, iso: str) -> None:
    """Single-row UPDATE. Caller commits."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter
               SET country_code = %s,
                   updated_at = now()
             WHERE id = %s
               AND country_code IS NULL
            """,
            (iso, fighter_id),
        )


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


def _resolve_country(http: RateLimitedClient, fighter: dict) -> Outcome:
    slug = fighter["slug"]
    name = fighter["name_en"]

    override_title = CHAMPION_TITLE_OVERRIDES.get(slug)
    if override_title is not None:
        iso, reason = country_for_wiki_title(http, override_title)
        return Outcome(slug, name, iso, f"override:{reason}", via_override=True)

    title, find_reason = find_article_title(http, name)
    if title is None:
        return Outcome(slug, name, None, f"search:{find_reason}", via_override=False)

    iso, p27_reason = country_for_wiki_title(http, title)
    return Outcome(slug, name, iso, f"wiki:{title}|{p27_reason}", via_override=False)


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run(*, limit: int | None, dry_run: bool, workers: int) -> dict:
    done = _load_checkpoint()
    totals = {
        "processed": 0,
        "matched": 0,
        "no_country": 0,
        "errors": 0,
        "via_override": 0,
        "unmapped_qid": 0,
    }
    unmapped_qids: dict[str, int] = {}

    with get_connection() as conn:
        targets = _select_targets(conn, limit=limit)
        targets = [t for t in targets if t["slug"] not in done]
        log.info(
            f"phase 6: country backfill — {len(targets)} fighters "
            f"(checkpointed: {len(done)}; overrides defined: {len(CHAMPION_TITLE_OVERRIDES)})"
        )
        if not targets:
            log.info("nothing to do — checkpoint or filter caught everything")
            return totals

        # Each worker holds its own rate-limited Client; they share the DB
        # connection only via the main thread (commits run on the main thread
        # after each future resolves, to keep psycopg single-threaded).
        thread_local = threading.local()

        def _worker(fighter: dict) -> Outcome:
            if not hasattr(thread_local, "client"):
                thread_local.client = RateLimitedClient()
            return _resolve_country(thread_local.client, fighter)

        # Map slug → row so we can look up the fighter id when applying.
        by_slug = {t["slug"]: t for t in targets}

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Countries", total=len(targets))

            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(_worker, t): t["slug"] for t in targets}
                for fut in as_completed(futures):
                    slug = futures[fut]
                    try:
                        outcome = fut.result()
                    except Exception as exc:  # noqa: BLE001
                        totals["errors"] += 1
                        log.error(f"{slug}: worker raised {exc!r}")
                        progress.advance(task)
                        continue

                    totals["processed"] += 1
                    if outcome.via_override:
                        totals["via_override"] += 1

                    if outcome.iso is None:
                        totals["no_country"] += 1
                        if outcome.reason.startswith("override:unmapped_qid:"):
                            qid = outcome.reason.split(":", 2)[2]
                            unmapped_qids[qid] = unmapped_qids.get(qid, 0) + 1
                        elif "unmapped_qid:" in outcome.reason:
                            qid = outcome.reason.split("unmapped_qid:")[1].split("|")[0]
                            unmapped_qids[qid] = unmapped_qids.get(qid, 0) + 1
                        log.info(
                            f"{outcome.name}: no country ({outcome.reason})"
                        )
                    else:
                        totals["matched"] += 1
                        if dry_run:
                            log.info(
                                f"[DRY] {outcome.name} -> {outcome.iso} ({outcome.reason})"
                            )
                        else:
                            row = by_slug[slug]
                            _update_country(conn, row["id"], outcome.iso)
                            conn.commit()
                            log.info(
                                f"{outcome.name} -> {outcome.iso} ({outcome.reason})"
                            )

                    done.add(slug)
                    progress.advance(task)

                    if totals["processed"] % CHECKPOINT_EVERY == 0 and not dry_run:
                        _save_checkpoint(done)

    if not dry_run:
        _save_checkpoint(done)
    totals["unmapped_qid"] = sum(unmapped_qids.values())
    if unmapped_qids:
        top = sorted(unmapped_qids.items(), key=lambda kv: -kv[1])[:20]
        log.info(f"unmapped Wikidata Q-ids (top 20): {top}")
    log.info(
        "phase 6 country backfill done: "
        f"processed={totals['processed']} matched={totals['matched']} "
        f"no_country={totals['no_country']} errors={totals['errors']} "
        f"via_override={totals['via_override']} unmapped_qid={totals['unmapped_qid']}"
    )
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill fighter.country_code.")
    parser.add_argument("--limit", type=int, default=None, help="cap target count")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print outcomes without writing to the DB or checkpoint",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=4,
        help="concurrent worker threads (default 4)",
    )
    args = parser.parse_args()

    log.info(
        f"WIKIDATA_COUNTRY_TO_ISO covers {len(WIKIDATA_COUNTRY_TO_ISO)} countries"
    )
    run(limit=args.limit, dry_run=args.dry_run, workers=args.workers)


if __name__ == "__main__":
    main()
