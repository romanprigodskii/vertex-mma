from __future__ import annotations

import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env.local")

DATABASE_URL = os.environ.get("DATABASE_URL")
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set. Populate .env.local at the project root.")


def get_connection() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, autocommit=False)
