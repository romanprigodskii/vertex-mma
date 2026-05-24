"""Full article-body extraction.

The RSS body is only a teaser — typically the first paragraph or a few
sentences. For "Results" / "live blog" articles that publishers update
in place once fights finish, the RSS snapshot we grabbed during the
pre-event window will never contain the actual results. This module
re-fetches the article URL and pulls the main article body via
`trafilatura`, replacing the stale RSS summary so the downstream
Haiku rephrase has real content to work with.
"""
from __future__ import annotations

import trafilatura

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


def extract_article(url: str) -> str | None:
    """Fetch `url` and return its main article body as plain text, or None
    when the page can't be fetched / no meaningful body is extracted."""
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        return None
    text = trafilatura.extract(downloaded, **_EXTRACT_KWARGS)
    if not text:
        return None
    text = text.strip()
    return text or None
