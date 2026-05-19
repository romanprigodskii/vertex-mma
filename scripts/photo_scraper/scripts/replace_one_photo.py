"""Replace one fighter's full+thumbnail photos from a local file."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Load .env.local from repo root.
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[3] / ".env.local")

from src.image_processor import process
from src.storage import upload, public_url


def main(slug: str, image_path: str) -> None:
    raw = Path(image_path).read_bytes()
    processed = process(raw)
    full_url = upload(f"{slug}/full.webp", content=processed.full_webp)
    thumb_url = upload(f"{slug}/thumbnail.webp", content=processed.thumbnail_webp)
    print(f"uploaded full     -> {full_url}")
    print(f"uploaded thumbnail -> {thumb_url}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: replace_one_photo.py <slug> <image_path>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
