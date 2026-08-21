import json

import dspy
import pytest

from whatchat_prompt_optimizer.optimize import (
    OptimizationError,
    extract_optimized_instruction,
    parse_args,
    require_api_key,
    split_train_val,
    write_artifact,
)
from whatchat_prompt_optimizer.signature import WhatsAppReply, build_program

# Every test in this file runs with no live model call and no GEMINI_API_KEY
# required - dspy.Predict/dspy.Example construction and attribute access
# never touch the network; only actually invoking a compiled program (or
# an optimizer's .compile()) does, which nothing here does.


def test_extract_optimized_instruction_uses_the_compiled_instructions_and_demos():
    program = build_program()
    program.signature = program.signature.with_instructions("Be extra concise and always offer to book a visit.")
    program.demos = [
        dspy.Example(customer_message="Are you open Saturday?", reply="We're closed Saturdays, open Mon-Fri 8-5.").with_inputs(
            "customer_message"
        )
    ]

    instruction = extract_optimized_instruction(program)

    assert "Be extra concise and always offer to book a visit." in instruction
    assert "Are you open Saturday?" in instruction
    assert "We're closed Saturdays, open Mon-Fri 8-5." in instruction


def test_extract_optimized_instruction_with_no_demos_is_just_the_instructions():
    program = build_program()
    program.signature = program.signature.with_instructions("Keep it short.")

    instruction = extract_optimized_instruction(program)

    assert instruction == "Keep it short."


def test_write_artifact_matches_the_node_side_import_shape(tmp_path):
    output = tmp_path / "artifact.json"
    write_artifact(output, "Be concise.", 0.87654, {"exampleCount": 2, "optimizer": "bootstrap"})

    artifact = json.loads(output.read_text(encoding="utf-8"))
    assert artifact == {
        "optimizedInstruction": "Be concise.",
        "metricName": "reply_quality_metric",
        "metricScore": 0.8765,
        "datasetSummary": {"exampleCount": 2, "optimizer": "bootstrap"},
    }


def test_write_artifact_refuses_to_write_an_empty_instruction(tmp_path):
    output = tmp_path / "artifact.json"
    with pytest.raises(OptimizationError, match="empty instruction"):
        write_artifact(output, "", 0.5, {})
    assert not output.exists()


def test_split_train_val_holds_out_a_real_fraction():
    examples = [dspy.Example(customer_message=str(i), reply=str(i)).with_inputs("customer_message") for i in range(10)]

    train, val = split_train_val(examples, 0.2)

    assert len(val) == 2
    assert len(train) == 8
    assert set(id(e) for e in train).isdisjoint(set(id(e) for e in val))  # no example in both sets


def test_split_train_val_never_empties_the_training_set_for_a_tiny_dataset():
    examples = [dspy.Example(customer_message="a", reply="b").with_inputs("customer_message")]

    train, val = split_train_val(examples, 0.5)

    assert len(train) == 1
    assert len(val) == 0


def test_require_api_key_fails_closed_when_unset(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(OptimizationError, match="GEMINI_API_KEY"):
        require_api_key()


def test_require_api_key_returns_the_real_value_when_set(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    assert require_api_key() == "test-key-123"


def test_parse_args_defaults():
    args = parse_args(["--dataset", "train.jsonl", "--output", "out.json"])
    assert args.model == "gemini-3.5-flash"
    assert args.optimizer == "bootstrap"
    assert args.val_fraction == 0.2


def test_parse_args_rejects_an_unknown_optimizer():
    with pytest.raises(SystemExit):
        parse_args(["--dataset", "train.jsonl", "--output", "out.json", "--optimizer", "not-a-real-optimizer"])


def test_the_real_signature_declares_exactly_the_fields_the_live_reply_path_can_supply():
    fields = set(WhatsAppReply.model_fields.keys())
    assert fields == {"persona", "tone", "business_context", "conversation_history", "customer_message", "reply"}
