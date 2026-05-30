"""Pure-Python tool implementations used by the MCP server. Each is a
plain function; MCP serialization happens in mcp_server.py.

All filesystem operations are sandboxed to AGENT_WORKDIR — any path
that resolves outside the root is rejected with a descriptive error
the LLM can reason about (rather than silently failing or escaping)."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .config import (
    AGENT_WORKDIR,
    BASH_TIMEOUT_SECONDS,
    FILE_READ_MAX_BYTES,
    FILE_WRITE_MAX_BYTES,
)


def _resolve_in_workdir(path_str: str) -> Path:
    """Resolve a user-supplied path against AGENT_WORKDIR, rejecting
    anything that escapes. Symlinks are followed via .resolve() so a
    symlink pointing outside the workdir is also caught."""
    raw = Path(path_str)
    target = (AGENT_WORKDIR / raw if not raw.is_absolute() else raw).resolve()
    try:
        target.relative_to(AGENT_WORKDIR)
    except ValueError as exc:
        raise PermissionError(
            f"path '{path_str}' resolves outside the agent workdir "
            f"({AGENT_WORKDIR}) — refused"
        ) from exc
    return target


def _truncate(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8", "replace")
    if len(encoded) <= max_bytes:
        return text
    return (
        encoded[:max_bytes].decode("utf-8", "ignore")
        + f"\n\n…(truncated to {max_bytes} bytes — {len(encoded)} total)"
    )


def bash(command: str, cwd: str | None = None) -> str:
    """Run a shell command in the agent's workdir."""
    if cwd:
        try:
            run_dir = _resolve_in_workdir(cwd)
        except PermissionError as exc:
            return f"error: {exc}"
        if not run_dir.is_dir():
            return f"error: cwd '{cwd}' is not a directory"
    else:
        run_dir = AGENT_WORKDIR
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=str(run_dir),
            capture_output=True,
            text=True,
            timeout=BASH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {BASH_TIMEOUT_SECONDS}s"
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc!r}"
    combined = (result.stdout or "") + (result.stderr or "")
    header = f"$ {command}\n[exit {result.returncode} in {run_dir}]\n"
    return header + _truncate(combined, max_bytes=16_000)


def read_file(path: str) -> str:
    """Read a file from inside the agent workdir."""
    try:
        target = _resolve_in_workdir(path)
    except PermissionError as exc:
        return f"error: {exc}"
    if not target.exists():
        return f"error: {path} does not exist"
    if not target.is_file():
        return f"error: {path} is not a file"
    try:
        data = target.read_bytes()
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc!r}"
    if len(data) > FILE_READ_MAX_BYTES:
        body = data[:FILE_READ_MAX_BYTES].decode("utf-8", "replace")
        return (
            body
            + f"\n\n…(truncated to {FILE_READ_MAX_BYTES} bytes — {len(data)} total)"
        )
    return data.decode("utf-8", "replace")


def write_file(path: str, content: str) -> str:
    """Overwrite a file (creating parents as needed)."""
    try:
        target = _resolve_in_workdir(path)
    except PermissionError as exc:
        return f"error: {exc}"
    encoded = content.encode("utf-8", "replace")
    if len(encoded) > FILE_WRITE_MAX_BYTES:
        return f"error: payload {len(encoded)} > max {FILE_WRITE_MAX_BYTES}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)
    return f"wrote {len(encoded)} bytes → {target.relative_to(AGENT_WORKDIR)}"


def list_dir(path: str = ".") -> str:
    """List directory contents inside the workdir."""
    try:
        target = _resolve_in_workdir(path)
    except PermissionError as exc:
        return f"error: {exc}"
    if not target.is_dir():
        return f"error: {path} is not a directory"
    entries: list[str] = []
    for entry in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name)):
        kind = "d" if entry.is_dir() else "f"
        try:
            size = entry.stat().st_size if entry.is_file() else "-"
        except Exception:  # noqa: BLE001
            size = "?"
        entries.append(f"{kind} {size:>9} {entry.name}")
    if not entries:
        return f"(empty: {target.relative_to(AGENT_WORKDIR) or '.'})"
    return "\n".join(entries)
