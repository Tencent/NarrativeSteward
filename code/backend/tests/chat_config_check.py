"""Verify explicit chat configuration and OpenAI-compatible requests offline."""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import httpx

from narrative_forge.config import build_chat_model


SETTINGS = {
    "OPENAI_API_KEY": "test-token",
    "OPENAI_BASE_URL": "https://chat.example.invalid/v1",
    "OPENAI_MODEL": "custom-chat-model",
    "LLM_MAX_RETRIES": "0",
}


def check_required_settings() -> None:
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"):
        for value in (None, "", "   ", "your_placeholder"):
            env = {**SETTINGS}
            if value is None:
                env.pop(name)
            else:
                env[name] = value
            with patch.dict(os.environ, env, clear=True):
                try:
                    build_chat_model()
                except RuntimeError as error:
                    assert name in str(error), str(error)
                    assert SETTINGS["OPENAI_API_KEY"] not in str(error)
                else:
                    raise AssertionError(f"Accepted missing configuration: {name}")


def check_chat_requests() -> None:
    def respond(request: httpx.Request, **kwargs) -> httpx.Response:
        assert str(request.url) == SETTINGS["OPENAI_BASE_URL"] + "/chat/completions"
        assert request.headers["authorization"] == "Bearer test-token"
        payload = json.loads(request.content)
        assert payload["model"] == SETTINGS["OPENAI_MODEL"]
        assert payload["tools"][0]["function"]["name"] == "inspect_story"
        if payload.get("stream"):
            chunks = [
                {"id": "chat-test", "object": "chat.completion.chunk", "created": 0,
                 "model": SETTINGS["OPENAI_MODEL"], "choices": [
                     {"index": 0, "delta": {"role": "assistant", "content": "Ready"},
                      "finish_reason": None}]},
                {"id": "chat-test", "object": "chat.completion.chunk", "created": 0,
                 "model": SETTINGS["OPENAI_MODEL"], "choices": [
                     {"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
            return httpx.Response(
                200, request=request, headers={"content-type": "text/event-stream"},
                content=(body + "data: [DONE]\n\n").encode(),
            )
        return httpx.Response(200, request=request, json={
            "id": "chat-test", "object": "chat.completion", "created": 0,
            "model": SETTINGS["OPENAI_MODEL"], "choices": [{
                "index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": None, "tool_calls": [{
                        "id": "call-test", "type": "function", "function": {
                            "name": "inspect_story", "arguments": '{"project_id":"example"}',
                        },
                    }],
                },
            }],
        })

    tool = {
        "type": "function", "function": {
            "name": "inspect_story", "description": "Inspect a story project.",
            "parameters": {"type": "object", "properties": {
                "project_id": {"type": "string"},
            }, "required": ["project_id"]},
        },
    }
    with patch.dict(os.environ, SETTINGS, clear=True), patch(
        "httpx.Client.send", side_effect=respond,
    ) as send:
        model = build_chat_model().bind_tools([tool])
        reply = model.invoke("Inspect the example project.")
        assert reply.tool_calls[0]["name"] == "inspect_story"
        assert reply.tool_calls[0]["args"] == {"project_id": "example"}
        chunks = list(model.stream("Continue."))
        assert "".join(chunk.content for chunk in chunks) == "Ready"
        assert send.call_count == 2


if __name__ == "__main__":
    check_required_settings()
    check_chat_requests()
    print("PASS: required chat settings, custom endpoint/model, tool calls and streaming.")
