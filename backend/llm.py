from abc import ABC, abstractmethod
import httpx


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, messages: list[dict]) -> str:
        pass


class MistralProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "mistral-small-latest"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://api.mistral.ai/v1"

    async def complete(self, messages: list[dict]) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"model": self.model, "messages": messages}
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]


class GroqProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "llama3-8b-8192"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://api.groq.com/openai/v1"

    async def complete(self, messages: list[dict]) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"model": self.model, "messages": messages}
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "gemini-1.5-flash"):
        self.api_key = api_key
        self.model = model

    async def complete(self, messages: list[dict]) -> str:
        # Convert OpenAI-style messages to Gemini format
        contents = []
        for m in messages:
            role = "model" if m["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m["content"]}]})

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                url,
                params={"key": self.api_key},
                json={"contents": contents},
            )
            response.raise_for_status()
            data = response.json()
            return data["candidates"][0]["content"]["parts"][0]["text"]


def get_provider(config: dict) -> LLMProvider:
    provider_name = config.get("provider", "mistral")
    cfg = config.get(provider_name, {})

    if provider_name == "mistral":
        return MistralProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "mistral-small-latest"),
        )
    elif provider_name == "groq":
        return GroqProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "llama3-8b-8192"),
        )
    elif provider_name == "gemini":
        return GeminiProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "gemini-1.5-flash"),
        )
    else:
        raise ValueError(f"Unknown provider: {provider_name}")
