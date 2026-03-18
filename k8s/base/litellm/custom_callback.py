"""
LiteLLM custom callback — emits structured data.llm events to stdout
for the Agent Warden governance lineage aggregator.

Mount this file in the LiteLLM container and set:
  litellm_settings:
    success_callback: ["custom_callback_handler.data_llm_callback"]

Ref: https://docs.litellm.ai/docs/observability/custom_callback
"""

import json
import sys
import os
from datetime import datetime, timezone
from litellm.integrations.custom_logger import CustomLogger


class DataLLMCallback(CustomLogger):
    def __init__(self):
        self.tenant_id = os.environ.get("TENANT_ID", "")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        """Called on every successful LLM completion."""
        try:
            usage = getattr(response_obj, "usage", None)
            model = kwargs.get("model", "unknown")
            litellm_params = kwargs.get("litellm_params", {})

            # Extract trace ID from metadata or headers
            metadata = kwargs.get("metadata", {}) or {}
            trace_id = (
                metadata.get("trace_id")
                or metadata.get("x-trace-id")
                or kwargs.get("litellm_call_id", "")
            )

            duration_ms = 0
            if start_time and end_time:
                duration_ms = int((end_time - start_time).total_seconds() * 1000)

            event = {
                "type": "data.llm",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "tenantId": self.tenant_id,
                "traceId": trace_id,
                "model": model,
                "provider": litellm_params.get("custom_llm_provider", "azure-openai"),
                "promptTokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
                "completionTokens": getattr(usage, "completion_tokens", 0) if usage else 0,
                "durationMs": duration_ms,
            }

            # Write to stdout as JSON line (Container Insights picks this up)
            sys.stdout.write(json.dumps(event) + "\n")
            sys.stdout.flush()
        except Exception:
            pass  # Fail silently — never block LLM responses


data_llm_callback = DataLLMCallback()
