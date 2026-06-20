import json
import os
import tempfile
from pathlib import Path

BOARDS_DIR = Path(__file__).parent.parent / "boards"


def _board_path(name: str) -> Path:
    # Board names become filenames; reject anything that could escape BOARDS_DIR
    # (path separators, traversal, empty). Names are otherwise free text.
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError(f"invalid board name: {name!r}")
    # Cap the length so the name + ".json" stays under the typical 255-byte
    # filename limit — otherwise open()/rename() raises an unhandled OSError (500).
    # 200 leaves headroom for the suffix and multi-byte chars.
    if len(name.encode("utf-8")) > 200:
        raise ValueError(f"board name too long: {len(name)} chars (max ~200)")
    return BOARDS_DIR / f"{name}.json"


def load_board(name: str) -> dict:
    path = _board_path(name)
    if not path.exists():
        return {"notes": []}
    try:
        with open(path) as f:
            return json.load(f)
    except json.JSONDecodeError:
        # A truncated/corrupt board file (e.g. an interrupted write) would
        # otherwise 500 the GET and leave the board unopenable. Degrade to an
        # empty board so the user can recover rather than being locked out.
        return {"notes": []}


def save_board(name: str, data: dict) -> None:
    BOARDS_DIR.mkdir(exist_ok=True)
    path = _board_path(name)
    # Write atomically: a crash mid-write would otherwise leave a truncated
    # JSON file that load_board can't parse. Write to a temp file in the same
    # dir, then rename (atomic on the same filesystem).
    fd, tmp = tempfile.mkstemp(dir=BOARDS_DIR, prefix=f".{name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        # Don't leave a stray temp file behind on failure.
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def list_boards() -> list[str]:
    if not BOARDS_DIR.exists():
        return []
    return sorted(p.stem for p in BOARDS_DIR.glob("*.json"))


def rename_board(old: str, new: str) -> None:
    src = _board_path(old)
    dst = _board_path(new)
    if not src.exists():
        raise FileNotFoundError(f"board not found: {old!r}")
    if dst.exists():
        raise FileExistsError(f"board already exists: {new!r}")
    src.rename(dst)


def delete_board(name: str) -> None:
    if name == "default":
        raise ValueError("the default board cannot be deleted")
    path = _board_path(name)
    if not path.exists():
        raise FileNotFoundError(f"board not found: {name!r}")
    path.unlink()
