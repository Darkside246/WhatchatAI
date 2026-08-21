import json

import pytest

from whatchat_prompt_optimizer.dataset import DatasetValidationError, load_dataset, to_dspy_examples


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def test_loads_a_real_valid_dataset(tmp_path):
    path = tmp_path / "train.jsonl"
    write_jsonl(
        path,
        [
            {"customer_message": "Are you open today?", "ideal_reply": "Yes, until 5pm."},
            {
                "customer_message": "How much for a callout?",
                "ideal_reply": "It's $89, waived if you proceed with the repair.",
                "persona": "Friendly",
                "tone": "warm",
                "business_context": "Plumbing company",
                "conversation_history": "Customer: hi\nAgent: hello!",
            },
        ],
    )

    dataset = load_dataset(path)

    assert len(dataset) == 2
    assert dataset.examples[0].customer_message == "Are you open today?"
    assert dataset.examples[0].persona == ""  # optional field defaults to empty, never fabricated
    assert dataset.examples[1].persona == "Friendly"


def test_skips_blank_lines_but_keeps_real_rows(tmp_path):
    path = tmp_path / "train.jsonl"
    path.write_text(
        '{"customer_message": "hi", "ideal_reply": "hello"}\n\n   \n{"customer_message": "bye", "ideal_reply": "goodbye"}\n',
        encoding="utf-8",
    )

    dataset = load_dataset(path)
    assert len(dataset) == 2


def test_rejects_a_missing_required_field(tmp_path):
    path = tmp_path / "train.jsonl"
    write_jsonl(path, [{"customer_message": "hi"}])  # no ideal_reply

    with pytest.raises(DatasetValidationError, match="ideal_reply"):
        load_dataset(path)


def test_rejects_an_empty_required_field(tmp_path):
    path = tmp_path / "train.jsonl"
    write_jsonl(path, [{"customer_message": "  ", "ideal_reply": "hello"}])

    with pytest.raises(DatasetValidationError, match="customer_message"):
        load_dataset(path)


def test_rejects_invalid_json(tmp_path):
    path = tmp_path / "train.jsonl"
    path.write_text("not json at all\n", encoding="utf-8")

    with pytest.raises(DatasetValidationError, match="invalid JSON"):
        load_dataset(path)


def test_rejects_an_unrecognized_field_rather_than_silently_ignoring_it(tmp_path):
    path = tmp_path / "train.jsonl"
    write_jsonl(path, [{"customer_message": "hi", "ideal_reply": "hello", "typo_feild": "oops"}])

    with pytest.raises(DatasetValidationError, match="typo_feild"):
        load_dataset(path)


def test_rejects_a_file_with_no_real_rows(tmp_path):
    path = tmp_path / "train.jsonl"
    path.write_text("\n\n", encoding="utf-8")

    with pytest.raises(DatasetValidationError, match="no real examples"):
        load_dataset(path)


def test_rejects_a_nonexistent_file(tmp_path):
    with pytest.raises(DatasetValidationError, match="not found"):
        load_dataset(tmp_path / "does-not-exist.jsonl")


def test_to_dspy_examples_marks_reply_as_the_only_non_input_field(tmp_path):
    path = tmp_path / "train.jsonl"
    write_jsonl(path, [{"customer_message": "hi", "ideal_reply": "hello"}])
    dataset = load_dataset(path)

    examples = to_dspy_examples(dataset)

    assert len(examples) == 1
    assert examples[0].customer_message == "hi"
    assert examples[0].reply == "hello"
    assert "reply" not in examples[0].inputs()
    assert "customer_message" in examples[0].inputs()
