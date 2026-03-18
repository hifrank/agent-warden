"""Agent-Warden PII/DLP Guardrail for LiteLLM."""
import re
import logging

from litellm.integrations.custom_guardrail import CustomGuardrail, GuardrailEventHooks
from litellm._logging import verbose_proxy_logger

logger = logging.getLogger("agent_warden.pii_guardrail")

PII_PATTERNS = [
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "redact"),
    ("Credit Card", re.compile(r"\b(?:\d[ -]*?){13,16}\b"), "redact"),
    ("Email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"), "redact"),
    ("Password", re.compile(r"password\s*[:=]\s*\S+", re.IGNORECASE), "redact"),
    ("Azure Conn String", re.compile(r"(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^;\s]+"), "block"),
    ("Bearer Token", re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE), "redact"),
    ("Private Key", re.compile(r"-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----"), "block"),
]


def _scan(text):
    findings = []
    for name, pat, action in PII_PATTERNS:
        for m in pat.finditer(text):
            findings.append((name, action, m.start(), m.end()))
    return findings


def _redact(text, findings):
    for name, _, start, end in sorted(findings, key=lambda f: f[2], reverse=True):
        text = text[:start] + "[" + name + " REDACTED]" + text[end:]
    return text


class AgentWardenPIIGuardrail(CustomGuardrail):
    def __init__(self, **kwargs):
        kwargs.setdefault("guardrail_name", "pii-dlp")
        kwargs.setdefault("event_hook", [GuardrailEventHooks.pre_call, GuardrailEventHooks.post_call])
        kwargs.setdefault("default_on", True)
        super().__init__(**kwargs)
        logger.warning(
            "Agent-Warden PII guardrail initialized (%d patterns)", len(PII_PATTERNS)
        )

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if "messages" not in data or not isinstance(data["messages"], list):
            return
        for msg in data["messages"]:
            content = msg.get("content")
            if not isinstance(content, str):
                continue
            findings = _scan(content)
            if findings:
                names = [f[0] for f in findings]
                msg["content"] = _redact(content, findings)
                verbose_proxy_logger.warning("PII-DLP REDACTED input: %s", names)

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        try:
            choices = getattr(response, "choices", None)
            if not choices:
                return
            for choice in choices:
                message = getattr(choice, "message", None)
                if not message:
                    continue
                content = getattr(message, "content", None)
                if not isinstance(content, str):
                    continue
                findings = _scan(content)
                if findings:
                    names = [f[0] for f in findings]
                    message.content = _redact(content, findings)
                    verbose_proxy_logger.warning("PII-DLP REDACTED output: %s", names)
        except Exception as e:
            logger.error("PII output scan error: %s", e)
