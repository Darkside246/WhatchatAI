"""Loads and validates a real training dataset for prompt optimization.

Deliberately strict: a malformed row is a hard error, not a silently
skipped one - an optimizer trained on silently-corrupted data would
produce an artifact whose quality claim (the metric score) cannot be
trusted. There is no synthetic/example fallback dataset shipped here; a
real one has to come from the operator's own real conversations.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import dspy

REQUIRED_FIELDS = ("customer_message", "ideal_reply")
OPTIONAL_TEXT_FIELDS = ("persona", "tone", "business_context", "conversation_history")


class DatasetValidationError(ValueError):
    """Raised for a malformed dataset file or row - never caught and
    silently downgraded to a warning."""


@dataclass(frozen=True)
class PromptExample:
    customer_message: str
    ideal_reply: str
    persona: str = ""
    tone: str = ""
    business_context: str = ""
    conversation_history: str = ""


@dataclass(frozen=True)
class LoadedDataset:
    examples: list[PromptExample] = field(default_factory=list)
    source_path: str = ""

    def __len__(self) -> int:
        return len(self.examples)


def _validate_row(raw: dict, line_number: int) -> PromptExample:
    if not isinstance(raw, dict):
        raise DatasetValidationError(f"line {line_number}: expected a JSON object, got {type(raw).__name__}")

    for required in REQUIRED_FIELDS:
        value = raw.get(required)
        if not isinstance(value, str) or not value.strip():
            raise DatasetValidationError(f"line {line_number}: missing or empty required field \"{required}\"")

    for optional in OPTIONAL_TEXT_FIELDS:
        value = raw.get(optional, "")
        if not isinstance(value, str):
            raise DatasetValidationError(f"line {line_number}: field \"{optional}\" must be a string if present")

    unknown = set(raw.keys()) - set(REQUIRED_FIELDS) - set(OPTIONAL_TEXT_FIELDS)
    if unknown:
        raise DatasetValidationError(f"line {line_number}: unrecognized field(s) {sorted(unknown)}")

    return PromptExample(
        customer_message=raw["customer_message"].strip(),
        ideal_reply=raw["ideal_reply"].strip(),
        persona=raw.get("persona", "").strip(),
        tone=raw.get("tone", "").strip(),
        business_context=raw.get("business_context", "").strip(),
        conversation_history=raw.get("conversation_history", "").strip(),
    )


def load_dataset(path: str | Path) -> LoadedDataset:
    """Reads a real JSONL file: one JSON object per non-blank line, each
    with a real `customer_message` and the operator's own `ideal_reply`
    for it. Raises DatasetValidationError on the first malformed row
    (fail fast, not fail partial) or if the file has no usable rows at
    all - never returns a dataset with zero examples, since an optimizer
    "compiled" against nothing is not a real optimization.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise DatasetValidationError(f"dataset file not found: {file_path}")

    examples: list[PromptExample] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as error:
                raise DatasetValidationError(f"line {line_number}: invalid JSON ({error})") from error
            examples.append(_validate_row(parsed, line_number))

    if not examples:
        raise DatasetValidationError(f"{file_path} contains no real examples - at least one is required")

    return LoadedDataset(examples=examples, source_path=str(file_path))


def to_dspy_examples(dataset: LoadedDataset) -> list[dspy.Example]:
    """Converts to DSPy's own Example type, marking every input field so
    the optimizer knows `reply` is the one field it must predict."""
    return [
        dspy.Example(
            persona=example.persona,
            tone=example.tone,
            business_context=example.business_context,
            conversation_history=example.conversation_history,
            customer_message=example.customer_message,
            reply=example.ideal_reply,
        ).with_inputs("persona", "tone", "business_context", "conversation_history", "customer_message")
        for example in dataset.examples
    ]
