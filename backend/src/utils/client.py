import os
import copy
import time
import litellm
from dotenv import load_dotenv
load_dotenv()

litellm.drop_params = True

LLM_CALL_DELAY = float(os.getenv("LLM_CALL_DELAY", "0"))

MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "5"))
RETRY_BASE_DELAY = float(os.getenv("LLM_RETRY_BASE_DELAY", "2"))

_PROVIDER_ENV_KEYS = {
    "OPENAI_API_KEY", "OPENAI_API_BASE",
    "ANTHROPIC_API_KEY",
    "AZURE_API_KEY", "AZURE_API_BASE", "AZURE_API_VERSION", "AZURE_ENDPOINT",
    "GEMINI_API_KEY",
    "TOGETHERAI_API_KEY",
    "OPENROUTER_API_KEY", "OPENROUTER_API_BASE",
    "XAI_API_KEY",
    "MISTRAL_API_KEY", "COHERE_API_KEY", "GROQ_API_KEY",
    "DEEPSEEK_API_KEY", "FIREWORKS_AI_API_KEY",
}


def _with_provider_prefix(model):
    if not model:
        return None
    return model if "/" in model else f"azure/{model}"


_CONFIG = {
    "model": _with_provider_prefix(os.getenv("MODEL")),
}

if os.getenv("AZURE_API_KEY"):
    os.environ["AZURE_API_KEY"] = os.getenv("AZURE_API_KEY")
if os.getenv("AZURE_ENDPOINT") and not os.getenv("AZURE_API_BASE"):
    os.environ["AZURE_API_BASE"] = os.getenv("AZURE_ENDPOINT")
if os.getenv("AZURE_API_VERSION"):
    os.environ["AZURE_API_VERSION"] = os.getenv("AZURE_API_VERSION")


def configure_llm(config):
    if not config:
        return

    env = config.get("env") or {}
    for key in _PROVIDER_ENV_KEYS:
        if key not in env:
            os.environ.pop(key, None)

    for key, value in env.items():
        if value is None or str(value).strip() == "":
            continue
        os.environ[str(key)] = str(value)

    if env.get("AZURE_ENDPOINT") and not env.get("AZURE_API_BASE"):
        os.environ["AZURE_API_BASE"] = str(env["AZURE_ENDPOINT"])

    if config.get("model"):
        _CONFIG["model"] = config["model"]


_SERVER_MODEL = _CONFIG["model"]


def is_configured():
    return bool(_CONFIG.get("model"))


def server_config_status():
    return {"configured": bool(_SERVER_MODEL), "model": _SERVER_MODEL}


def _require_model():
    model = _CONFIG.get("model")
    if not model:
        raise RuntimeError(
            "No LLM configured. Add your API keys and model name via "
            "Edit › Edit API Keys."
        )
    return model


def _make_nullable(schema):
    if not isinstance(schema, dict):
        return schema
    t = schema.get("type")
    if t is None or t == "null":
        return schema
    if isinstance(t, list):
        return schema if "null" in t else {**schema, "type": t + ["null"]}
    return {**schema, "type": [t, "null"]}


def _strictify_schema(node):
    def transform(n):
        if isinstance(n, dict):
            n = {k: transform(v) for k, v in n.items()}
            if n.get("type") == "object" and isinstance(n.get("properties"), dict):
                prop_names = list(n["properties"].keys())
                previously_required = set(n.get("required") or [])
                for name in prop_names:
                    if name not in previously_required:
                        n["properties"][name] = _make_nullable(n["properties"][name])
                n["required"] = prop_names
                n["additionalProperties"] = False
            return n
        if isinstance(n, list):
            return [transform(x) for x in n]
        return n

    return transform(copy.deepcopy(node))


def _prepare_response_schema(response_schema):
    if not isinstance(response_schema, dict):
        return response_schema
    prepared = dict(response_schema)
    if isinstance(prepared.get("schema"), dict):
        prepared["schema"] = _strictify_schema(prepared["schema"])
    return prepared


def _call_with_retry(fn, *args, **kwargs):
    if LLM_CALL_DELAY > 0:
        time.sleep(LLM_CALL_DELAY)
    for attempt in range(MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            is_rate_limit = "429" in str(e) or "rate" in str(e).lower()
            if not is_rate_limit or attempt == MAX_RETRIES:
                raise
            wait = RETRY_BASE_DELAY * (2 ** attempt)
            print(f"  [rate-limit] 429 — retrying in {wait:.0f}s (attempt {attempt + 1}/{MAX_RETRIES})")
            time.sleep(wait)


def _extract_logprob_object(response):
    try:
        return response.choices[0].logprobs.content[0]
    except (AttributeError, IndexError, TypeError):
        return None


def _extract_logprob_value(response):
    obj = _extract_logprob_object(response)
    return getattr(obj, "logprob", 0.0) if obj is not None else 0.0


def _response_cost(response):
    try:
        return response._hidden_params.get("response_cost", 0.0) or 0.0
    except (AttributeError, TypeError):
        return 0.0


def obtain_llm_response_with_schema(temperature, response_schema, prompt):
    return _call_with_retry(
        litellm.completion,
        model=_require_model(),
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
        response_format={"type": "json_schema", "json_schema": _prepare_response_schema(response_schema)},
        logprobs=True,
    )


def obtain_llm_response(temperature, prompt):
    return _call_with_retry(
        litellm.completion,
        model=_require_model(),
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
        logprobs=True,
    )


def invoke_llm_with_schema(prompt, response_schema, temperature=None):
    response = obtain_llm_response_with_schema(temperature, response_schema, prompt)
    content = response.choices[0].message["content"]
    logprob = _extract_logprob_object(response)
    cost = _response_cost(response)
    return content, logprob, cost


def invoke_llm(prompt, temperature=None):
    response = obtain_llm_response(temperature, prompt)
    content = response.choices[0].message["content"]
    logprob = _extract_logprob_value(response)
    cost = _response_cost(response)
    return content, logprob, cost


if __name__ == "__main__":
    output_format = {
        "name": "choice_schema",
        "schema": {
            "type": "object",
            "properties": {
                "choice": {
                    "type": "string",
                    "enum": ["A", "B"]
                }
            },
            "required": ["choice"]
        }
    }

    output, logprob, cost = invoke_llm_with_schema(
                                prompt = "A or B? Pick your choice",
                                response_schema = output_format,
                                temperature = 0.0
                            )
    print(f"Output: {output}\nLogprob: {logprob}\nCost: ${cost:.6f}")
