"""Full article-body extraction.

The RSS body is only a teaser — typically the first paragraph or a few
sentences. For "Results" / "live blog" articles that publishers update
in place once fights finish, the RSS snapshot we grabbed during the
pre-event window will never contain the actual results. This module
re-fetches the article URL and pulls the main article body via
`trafilatura`, replacing the stale RSS summary so the downstream
Haiku rephrase has real content to work with.

We also quality-check the extraction: pre-event live-blog pages
contain repeated scaffolding ("Tudor Leonte scores the round:" with no
actual score) that trafilatura preserves faithfully. Feeding that into
Haiku produces a rephrase that just repeats the scaffolding. Reject
those rather than save them.

`extract_article_full` also pulls a list of NewsExternalRef-shaped dicts
from the downloaded HTML (see ref_extractor.extract_refs). These land in
news_item.external_refs and drive the article page's inline platform
links + social-embed cards.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import trafilatura

from .ref_extractor import extract_refs

# Trafilatura defaults are good for major news outlets. `favor_precision`
# trims marketing rails / comment threads; `include_comments=False`
# explicitly drops any disqus-style appendix that would confuse the
# rephraser.
_EXTRACT_KWARGS = {
    "favor_precision": True,
    "include_comments": False,
    "include_tables": False,
    "deduplicate": True,
}


_SCAFFOLDING_RX = re.compile(r"scores?\s+the\s+round:", re.IGNORECASE)
_ROUND_HEADER_RX = re.compile(
    r"Round\s+\d+\s+(?:Sherdog\s+)?Scores", re.IGNORECASE
)
_OFFICIAL_RESULT_RX = re.compile(
    r"The\s+Official\s+Result", re.IGNORECASE
)


def is_low_quality_body(text: str | None) -> bool:
    """Heuristic — True when the extracted text is mostly live-blog
    scaffolding / template content rather than a real article."""
    if not text:
        return True

    # Repeated "scores the round:" with no numeric score = pre-event
    # scorecard template.
    if len(_SCAFFOLDING_RX.findall(text)) >= 5:
        return True

    # Repeated "Round N Scores" / "The Official Result" headers with no
    # filled-in content between them = a results template waiting for the
    # event to happen.
    if len(_ROUND_HEADER_RX.findall(text)) >= 4:
        return True
    if len(_OFFICIAL_RESULT_RX.findall(text)) >= 4:
        return True

    # General repetition catch — if most "sentences" are duplicates of
    # each other, the body is template noise.
    sentences = re.split(r"[.\n]+", text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 15]
    if len(sentences) >= 10:
        unique = len(set(sentences))
        if unique / len(sentences) < 0.4:
            return True

    return False


@dataclass
class ExtractedArticle:
    body: str
    refs: list[dict]


def extract_article(url: str) -> str | None:
    """Backward-compat: return just the body string, or None on failure.
    New callers should use `extract_article_full` to also get refs."""
    result = extract_article_full(url)
    return result.body if result else None


def extract_article_full(url: str) -> ExtractedArticle | None:
    """Fetch `url`, return its body text plus a list of external refs
    extracted from the same article body. None when the body fails the
    quality check or the fetch fails.

    Refs are extracted from trafilatura's cleaned article HTML, NOT the
    raw page — so site chrome (nav menus, footers, related-article
    rails) doesn't leak into the refs list.
    """
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        return None
    text = trafilatura.extract(downloaded, **_EXTRACT_KWARGS)
    if not text:
        return None
    text = text.strip()
    if not text or is_low_quality_body(text):
        return None
    html_body = trafilatura.extract(
        downloaded, output_format="html", **_EXTRACT_KWARGS
    )
    refs = extract_refs(html_body) if html_body else []
    return ExtractedArticle(body=text, refs=refs)
