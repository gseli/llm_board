import json
from pathlib import Path

BOARDS_DIR = Path(__file__).parent.parent / "boards"


def _board_path(name: str) -> Path:
    # Board names become filenames; reject anything that could escape BOARDS_DIR
    # (path separators, traversal, empty). Names are otherwise free text.
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError(f"invalid board name: {name!r}")
    return BOARDS_DIR / f"{name}.json"


def load_board(name: str) -> dict:
    path = _board_path(name)
    if not path.exists():
        return {"notes": []}
    with open(path) as f:
        return json.load(f)


def save_board(name: str, data: dict) -> None:
    BOARDS_DIR.mkdir(exist_ok=True)
    path = _board_path(name)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


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
