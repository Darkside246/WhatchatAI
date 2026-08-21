"""A real LLM-judge metric for scoring a generated reply against the
operator's own `ideal_reply` for that example - the standard DSPy pattern
for a task like this one, where exact-string-match is meaningless (many
different phrasings of the same correct reply are all "correct").

This calls the same configured LM the optimizer itself uses (dspy.settings.lm)
for every scored example, so running a real optimization pass over a
dataset of N examples costs on the order of N additional model calls just
for judging, on top of the optimizer's own calls - a real, non-trivial
cost the operator should expect, not a hidden one.
"""

from __future__ import annotations

import dspy


class JudgeReply(dspy.Signature):
    """Judge whether a candidate WhatsApp reply is an acceptable
    substitute for the real, operator-authored ideal reply - same
    substance, same tone, no invented facts, no missing important
    information. Score 1.0 for a fully acceptable reply, 0.0 for one that
    would embarrass the business or mislead the customer, and a real
    intermediate value for anything in between."""

    customer_message: str = dspy.InputField()
    ideal_reply: str = dspy.InputField()
    candidate_reply: str = dspy.InputField()
    score: float = dspy.OutputField(desc="A number from 0.0 to 1.0")


_judge = dspy.Predict(JudgeReply)


def reply_quality_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """DSPy's real metric signature: (example, prediction, trace) -> float
    (or bool during bootstrapping - a score >= 0.6 counts as a pass for
    that purpose). Never fabricates a score for a prediction with no real
    `reply` text - that is an automatic 0.0, not skipped.
    """
    candidate = getattr(prediction, "reply", None)
    if not candidate or not str(candidate).strip():
        return 0.0

    judged = _judge(
        customer_message=example.customer_message,
        ideal_reply=example.reply,
        candidate_reply=candidate,
    )
    try:
        score = float(judged.score)
    except (TypeError, ValueError):
        # The judge itself is a live model call and can misbehave (return
        # non-numeric text) - fails to the strict, honest end (0.0) rather
        # than crashing the whole optimization run or fabricating a pass.
        return 0.0
    return max(0.0, min(1.0, score))
