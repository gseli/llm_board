from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional

from config import load_config
from llm import get_provider
from storage import load_board, save_board, list_boards, rename_board

app = FastAPI()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


class PromptRequest(BaseModel):
    prompt: Optional[str] = None
    messages: Optional[list] = None  # [{role, content}, ...]


class BoardData(BaseModel):
    notes: list
    layout: Optional[str] = None  # "tree" once migrated; absent on legacy boards
    pill_pos: Optional[dict] = None  # dragged orbit-pill positions, keyed "resp:move"


class RenameRequest(BaseModel):
    new_name: str


@app.get("/boards")
def get_boards():
    return {"boards": list_boards()}


@app.get("/board/{name}")
def get_board(name: str):
    return load_board(name)


@app.post("/board/{name}")
def post_board(name: str, data: BoardData):
    save_board(name, data.model_dump())
    return {"status": "saved"}


@app.post("/board/{name}/rename")
def rename(name: str, req: RenameRequest):
    try:
        rename_board(name, req.new_name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "renamed", "name": req.new_name}


@app.post("/prompt")
async def run_prompt(req: PromptRequest):
    config = load_config()
    try:
        provider = get_provider(config)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if req.messages:
        messages = req.messages
    elif req.prompt:
        messages = [{"role": "user", "content": req.prompt}]
    else:
        raise HTTPException(status_code=400, detail="Either prompt or messages required")

    try:
        result = await provider.complete(messages)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return {"response": result}


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
