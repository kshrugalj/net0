"""
Shared LLM client for all AI features.

Uses Google Gemini via the google-genai SDK.
Set GEMINI_API_KEY in backend/.env (optional GEMINI_MODEL).
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
# backend/.env is the project key. Override a stale key inherited by the server process.
load_dotenv(_ENV_PATH, override=True)

_last_error: str | None = None


def last_llm_error() -> str | None:
    return _last_error


def _remember_error(exc: Exception | None) -> None:
    global _last_error
    if exc is None:
        _last_error = None
        return
    status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if status == 401 or "UNAUTHENTICATED" in str(exc):
        _last_error = "Gemini rejected the API key. Agent paused."
        return
    _last_error = "Gemini did not respond. Agent paused."

DEFAULT_MODEL = "gemini-3.5-flash-lite"
_MAX_ATTEMPTS = 3
_RETRY_DELAY_S = 1.5
_client_instance = None
_client_key: str | None = None


def gemini_configured() -> bool:
    load_dotenv(_ENV_PATH, override=True)
    return bool(os.getenv("GEMINI_API_KEY", "").strip())


def _client():
    global _client_instance, _client_key
    load_dotenv(_ENV_PATH, override=True)
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    if _client_instance is None or _client_key != api_key:
        from google import genai

        _client_instance = genai.Client(api_key=api_key)
        _client_key = api_key
    return _client_instance


def _response_text(response: object) -> str:
    text = getattr(response, "text", None) or ""
    if text.strip():
        return text.strip()
    candidates = getattr(response, "candidates", None) or []
    chunks: list[str] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            if getattr(part, "thought", None):
                continue
            part_text = getattr(part, "text", None) or ""
            if part_text.strip():
                chunks.append(part_text.strip())
    return "\n".join(chunks).strip()


def _status_code(exc: Exception) -> int | None:
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if isinstance(code, int):
        return code
    message = str(exc)
    for status in (401, 429, 500, 503):
        if str(status) in message:
            return status
    return None


def call_llm(
    prompt: str,
    *,
    system: str | None = None,
    max_output_tokens: int | None = None,
    json_mode: bool = False,
) -> str | None:
    """
    Send a prompt to Gemini and return raw text.

    Returns None if GEMINI_API_KEY is missing or the call fails.
    json_mode asks Gemini for an application/json body. Without it,
    gemini-3.5-flash-lite often returns an empty MALFORMED_RESPONSE.
    """
    global _last_error
    client = _client()
    if client is None:
        _last_error = "GEMINI_API_KEY is not set. Agent paused."
        logger.warning("GEMINI_API_KEY not set; skipping LLM call")
        return None

    model = os.getenv("GEMINI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL

    from google.genai import types
    from google.genai import errors as genai_errors

    config_kwargs: dict = {
        "automatic_function_calling": types.AutomaticFunctionCallingConfig(
            disable=True
        ),
    }
    if system:
        config_kwargs["system_instruction"] = system
    if max_output_tokens is not None:
        config_kwargs["max_output_tokens"] = max_output_tokens
    if json_mode:
        config_kwargs["response_mime_type"] = "application/json"
    config = types.GenerateContentConfig(**config_kwargs)

    last_err: Exception | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
            text = _response_text(response)
            if text:
                _last_error = None
                return text
            finish = None
            candidates = getattr(response, "candidates", None) or []
            if candidates:
                finish = getattr(candidates[0], "finish_reason", None)
            logger.warning(
                "Gemini returned an empty body (model=%s attempt=%s finish=%s)",
                model,
                attempt,
                finish,
            )
            last_err = None
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_S * attempt)
                continue
            _last_error = "Gemini returned an empty response. Agent paused."
            return None
        except genai_errors.ServerError as e:
            last_err = e
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_S * attempt)
                continue
        except genai_errors.ClientError as e:
            last_err = e
            if _status_code(e) == 429 and attempt < _MAX_ATTEMPTS:
                time.sleep(_RETRY_DELAY_S * attempt * 2)
                continue
            break
        except Exception as e:
            last_err = e
            break

    _remember_error(last_err)
    logger.exception(
        "Gemini call_llm failed (model=%s)", model, exc_info=last_err
    )
    return None


def parse_llm_json(raw: str) -> dict:
    """Strip optional markdown fences and parse JSON object/array."""
    import json

    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("LLM JSON root must be an object")
    return payload
