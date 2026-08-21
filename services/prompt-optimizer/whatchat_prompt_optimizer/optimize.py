"""CLI entrypoint: run a real DSPy optimization pass and write a JSON
artifact an operator reviews, then imports through WhatchatAI's own
POST /api/workspace/agents/:agentId/prompt-optimizations endpoint.

This process never talks to WhatchatAI's Postgres database and is never
invoked from the live reply path - it is a manual, offline tool. It DOES
make real, billed calls to whichever Gemini model you point it at (once
per optimizer step, plus once per judged example - see metric.py), so
running it against a real dataset has a real, non-trivial API cost the
operator should expect going in.

Usage:
    python -m whatchat_prompt_optimizer.optimize \\
        --dataset path/to/train.jsonl \\
        --model gemini-3.5-flash \\
        --optimizer bootstrap \\
        --output artifact.json

Requires GEMINI_API_KEY in the environment - there is no other credential
source, and the process refuses to start without one rather than silently
running against nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

import dspy

from .dataset import DatasetValidationError, load_dataset, to_dspy_examples
from .metric import reply_quality_metric
from .signature import build_program

DEFAULT_MODEL = "gemini-3.5-flash"


class OptimizationError(RuntimeError):
    """Raised for a real, actionable failure in the optimization run
    itself (not a dataset/argument problem, which raise their own,
    more specific errors)."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a real DSPy prompt optimization pass for one WhatchatAI AI agent.")
    parser.add_argument("--dataset", required=True, help="Path to a JSONL training dataset (see README.md for the row format).")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model name, without the 'gemini/' LiteLLM prefix (default: {DEFAULT_MODEL}).")
    parser.add_argument("--optimizer", choices=["bootstrap", "gepa"], default="bootstrap", help="bootstrap (default, cheaper) or gepa (more thorough, more expensive).")
    parser.add_argument("--output", required=True, help="Path to write the JSON artifact to.")
    parser.add_argument("--val-fraction", type=float, default=0.2, help="Fraction of the dataset held out for scoring/GEPA validation (default: 0.2).")
    return parser.parse_args(argv)


def require_api_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise OptimizationError(
            "GEMINI_API_KEY is not set. This tool makes real calls to Gemini and refuses to run without a real key "
            "rather than silently doing nothing or fabricating a result."
        )
    return api_key


def split_train_val(examples: list[dspy.Example], val_fraction: float) -> tuple[list[dspy.Example], list[dspy.Example]]:
    if not examples:
        raise OptimizationError("no examples to split")
    val_count = max(1, round(len(examples) * val_fraction)) if len(examples) > 1 else 0
    val_count = min(val_count, len(examples) - 1) if len(examples) > 1 else 0
    return examples[val_count:], examples[:val_count]


def build_optimizer(name: str, metric):
    if name == "bootstrap":
        return dspy.BootstrapFewShot(metric=metric, max_bootstrapped_demos=4, max_labeled_demos=8)
    if name == "gepa":
        # GEPA (the optimizer the original architecture proposal named
        # explicitly) reflects on failures using its own LM - reusing the
        # same task LM is the simplest real default; a dedicated,
        # stronger reflection model is a real future option, not
        # required to run.
        return dspy.GEPA(metric=metric, reflection_lm=dspy.settings.lm, auto="light")
    raise OptimizationError(f"unknown optimizer: {name}")


def score_program(program: dspy.Module, examples: list[dspy.Example]) -> float:
    """The final, honestly-reported metric score: the compiled program's
    average reply_quality_metric over held-out (never-trained-on)
    examples, when any exist - a score computed only on the training set
    would overstate real quality.
    """
    if not examples:
        return 0.0
    scores = []
    for example in examples:
        prediction = program(
            persona=example.persona,
            tone=example.tone,
            business_context=example.business_context,
            conversation_history=example.conversation_history,
            customer_message=example.customer_message,
        )
        scores.append(reply_quality_metric(example, prediction))
    return statistics.mean(scores)


def extract_optimized_instruction(compiled: dspy.Module) -> str:
    """Turns a compiled DSPy program back into the flat instruction string
    WhatchatAI's ai_agents.system_instruction actually is. The Predict
    module's own (possibly optimizer-rewritten) instructions come first;
    any bootstrapped few-shot demos are appended as a real worked-example
    block, since that's the only way a flat string field can carry them.
    """
    predictor = compiled.predictors()[0] if compiled.predictors() else compiled
    instructions = getattr(predictor.signature, "instructions", "") or ""
    parts = [instructions.strip()] if instructions.strip() else []

    demos = getattr(predictor, "demos", None) or []
    if demos:
        parts.append("Worked examples:")
        for demo in demos:
            customer_message = getattr(demo, "customer_message", "")
            reply = getattr(demo, "reply", "")
            if customer_message and reply:
                parts.append(f'Customer: "{customer_message}"\nReply: "{reply}"')

    return "\n\n".join(parts).strip()


def write_artifact(output_path: str | Path, optimized_instruction: str, metric_score: float, dataset_summary: dict) -> None:
    if not optimized_instruction:
        raise OptimizationError(
            "the compiled program produced an empty instruction - refusing to write an artifact that would clear "
            "out the agent's real system instruction on import"
        )
    artifact = {
        "optimizedInstruction": optimized_instruction,
        "metricName": "reply_quality_metric",
        "metricScore": round(metric_score, 4),
        "datasetSummary": dataset_summary,
    }
    Path(output_path).write_text(json.dumps(artifact, indent=2), encoding="utf-8")


def run(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        dataset = load_dataset(args.dataset)
    except DatasetValidationError as error:
        print(f"Dataset error: {error}", file=sys.stderr)
        return 1

    try:
        api_key = require_api_key()
    except OptimizationError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 1

    dspy.configure(lm=dspy.LM(f"gemini/{args.model}", api_key=api_key))

    examples = to_dspy_examples(dataset)
    trainset, valset = split_train_val(examples, args.val_fraction)

    program = build_program()
    optimizer = build_optimizer(args.optimizer, reply_quality_metric)
    compiled = optimizer.compile(program, trainset=trainset, valset=valset or trainset)

    optimized_instruction = extract_optimized_instruction(compiled)
    metric_score = score_program(compiled, valset or trainset)

    write_artifact(
        args.output,
        optimized_instruction,
        metric_score,
        dataset_summary={
            "exampleCount": len(dataset),
            "trainCount": len(trainset),
            "valCount": len(valset),
            "optimizer": args.optimizer,
            "model": args.model,
            "sourcePath": dataset.source_path,
        },
    )
    print(f"Wrote {args.output} (metric score: {metric_score:.4f}, {len(dataset)} examples)")
    return 0


if __name__ == "__main__":
    sys.exit(run())
