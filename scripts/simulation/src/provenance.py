"""What produced an artifact — recorded next to it, because otherwise nobody
can tell.

The concrete case this exists for: two days of incremental scraping (89 updated
bouts, 3 new, 48 new Sherdog rows) moved LightGBM's predictions by 4.5e-6,
LogReg's by 6.6e-5 and **CatBoost's by 4.5e-3**. The thread-nondeterminism
hypothesis was tested and refuted — an idle machine reproduces to seven
decimals. What was left was undiagnosable from the artifact alone: a `.cbm`
file records neither the data it saw nor the library that wrote it, and
`requirements.txt` carries lower bounds only, so "the dataset moved" and
"catboost auto-upgraded a minor version" leave exactly the same trace, which is
none.

So `metadata.json` now carries, per run: the git SHA the code came from, the
resolved versions of every library that touches the weights, the platform, a
content hash of the training frame, and the iteration counts each learner
actually stopped at. Three of those four are constant on a normal weekly
retrain, so a change in any one of them names its own suspect.

Deliberately NOT recorded: hostname, username, absolute paths, environment
variables. This file is committed to a public repository every Sunday by a
cron with push access — provenance is a debugging aid, not an inventory of the
machine.

Deliberately not written into the weight files themselves (`finish_hazard.json`,
`decision_winner.json`, the `.cbm`/`.txt` learners): those are pure functions of
the data today, so `git diff` on them means "the model moved" and nothing else.
Stamping a SHA into them would make every retrain a diff and destroy the
signal. `metadata.json` already changes every run — it carries a `trained_at`
— so it is the honest place for a stamp.
"""

from __future__ import annotations

import hashlib
import platform
import subprocess
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# src/ -> scripts/simulation/ -> scripts/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]

# Everything whose version can move a weight. `pyarrow` is in the list because
# it round-trips `dataset.parquet`, and `scipy` because sklearn's solvers use
# it. `rich` and friends cannot change a number and are left out on purpose.
TRACKED_LIBRARIES = (
    "lightgbm",
    "catboost",
    "scikit-learn",
    "numpy",
    "pandas",
    "scipy",
    "pyarrow",
    "optuna",
)


def _git(*args: str) -> str | None:
    """Run a read-only git command in the repo, or return None if git is
    unavailable, the checkout is not a repo, or the command fails. Never
    raises: a missing SHA must not be able to fail a retrain."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def git_provenance() -> dict[str, Any]:
    """The commit the training code came from.

    `dirty` is scoped to `scripts/simulation/` and excludes `artifacts/`: an
    edit elsewhere in the monorepo does not make these weights unreproducible,
    and the artifacts are the very files this run is in the middle of writing.
    """
    status = _git("status", "--porcelain", "--", "scripts/simulation")
    dirty: bool | None
    if status is None:
        dirty = None
    else:
        tracked = [
            line for line in status.splitlines()
            if "scripts/simulation/artifacts/" not in line
        ]
        dirty = bool(tracked)
    return {
        "sha": _git("rev-parse", "HEAD"),
        "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "committed_at": _git("show", "-s", "--format=%cI", "HEAD"),
        "dirty": dirty,
    }


def library_versions() -> dict[str, str]:
    """Resolved versions, not the lower bounds in requirements.txt."""
    versions: dict[str, str] = {}
    for name in TRACKED_LIBRARIES:
        try:
            versions[name] = importlib_metadata.version(name)
        except importlib_metadata.PackageNotFoundError:
            versions[name] = "absent"
    return versions


def runtime_provenance() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "system": platform.system(),
        "machine": platform.machine(),
    }


def dataset_fingerprint(df: pd.DataFrame) -> dict[str, Any]:
    """A content hash of the training frame.

    `hash_pandas_object` is row-wise and order-sensitive, which is what we
    want: `BOUTS_SQL`'s ordering is load-bearing for the whole point-in-time
    walk, so a frame that changed order is a different frame even if it holds
    the same rows. The digest is only comparable within one pandas version —
    which is recorded beside it, so a mismatch is attributable rather than
    mysterious.

    Hashing must never fail a retrain, so an unhashable column degrades to a
    shape-only fingerprint with the reason attached.
    """
    fp: dict[str, Any] = {
        "n_rows": int(len(df)),
        "n_columns": int(df.shape[1]),
        "columns_sha256": hashlib.sha256(
            "\n".join(str(c) for c in df.columns).encode()
        ).hexdigest(),
    }
    if "event_date" in df.columns:
        dates = pd.to_datetime(df["event_date"], errors="coerce")
        if dates.notna().any():
            fp["event_date_min"] = str(dates.min().date())
            fp["event_date_max"] = str(dates.max().date())
    try:
        row_hashes = pd.util.hash_pandas_object(df, index=False).to_numpy()
        fp["content_sha256"] = hashlib.sha256(row_hashes.tobytes()).hexdigest()
    except Exception as exc:  # noqa: BLE001 — provenance is never load-bearing
        fp["content_sha256"] = None
        fp["content_hash_error"] = f"{type(exc).__name__}: {exc}"
    return fp


def learner_iterations(model: Any) -> dict[str, int | None]:
    """Where each learner actually stopped.

    Two numbers per gradient booster, and they answer different questions.
    `*_best_iteration` is what early stopping chose on val — a model quantity,
    and the one `refit_on_all` transfers. `*_trees` is what the object in front
    of you actually holds, which for a production refit is the transferred
    count and for a split fit is the full un-truncated run. Reading only the
    first would make a served model look like it stopped early when it did not.
    """
    out: dict[str, int | None] = {}

    booster = getattr(model, "lgb_global", None)
    if booster is not None:
        best = getattr(booster, "best_iteration", None)
        out["lgb_best_iteration"] = int(best) if best else None
        try:
            out["lgb_trees"] = int(booster.num_trees())
        except Exception:  # noqa: BLE001
            out["lgb_trees"] = None

    cb = getattr(model, "cb_global", None)
    if cb is not None:
        try:
            best_cb = cb.get_best_iteration()
        except Exception:  # noqa: BLE001
            best_cb = None
        # CatBoost counts from zero; +1 is the round count, matching how
        # `refit_on_all` and `method_model.best_iters` use it.
        out["cb_best_iteration"] = None if best_cb is None else int(best_cb) + 1
        out["cb_trees"] = int(getattr(cb, "tree_count_", 0)) or None

    logreg = getattr(model, "logreg", None)
    n_iter = getattr(logreg, "n_iter_", None)
    if n_iter is not None:
        out["logreg_n_iter"] = int(np.ravel(n_iter)[0])

    return out


def collect_provenance(dataset: pd.DataFrame | None = None) -> dict[str, Any]:
    """The block `metadata.json` carries. Cheap — one git call per field, no
    model work — so it can be collected unconditionally."""
    block: dict[str, Any] = {
        "git": git_provenance(),
        "runtime": runtime_provenance(),
        "libraries": library_versions(),
    }
    if dataset is not None:
        block["dataset"] = dataset_fingerprint(dataset)
    return block
