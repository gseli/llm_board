import json
from pathlib import Path

BOARDS_DIR = Path(__file__).parent.parent / "boards"


def load_board(name: str) -> dict:
    path = BOARDS_DIR / f"{name}.json"
    if not path.exists():
        return {"notes": []}
    with open(path) as f:
        return json.load(f)


def save_board(name: str, data: dict) -> None:
    BOARDS_DIR.mkdir(exist_ok=True)
    path = BOARDS_DIR / f"{name}.json"
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
