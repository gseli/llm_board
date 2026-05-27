from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path

from config import load_config
from llm import get_provider
from storage import load_board, save_board

app = FastAPI()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


class PromptRequest(BaseModel):
    prompt: str


class BoardData(BaseModel):
    notes: list


@app.get("/board/{name}")
def get_board(name: str):
    return load_board(name)


@app.post("/board/{name}")
def post_board(name: str, data: BoardData):
    save_board(name, data.model_dump())
    return {"status": "saved"}


@app.post("/prompt")
async def run_prompt(req: PromptRequest):
    config = load_config()
    try:
        provider = get_provider(config)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))
    try:
        result = await provider.complete(req.prompt)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return {"response": result}


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
