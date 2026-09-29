---
description: 'How to design an eval whose verdict means something: a dataset weighted toward failures, the cheapest scorer that decides each item, a noise floor measured before a delta is trusted, judges calibrated against human grades, and a held-out set behind the promotion gate.'
keywords:
  - eval design
  - evaluation dataset
  - llm judge calibration
  - noise floor
  - held-out set
---

# Eval Design

[Evaluations](../modules/evaluations.md) guarantees the mechanics: every item runs against the real agent, inputs are frozen, one version is pinned, errors are counted apart. What a verdict _means_ is decided by the items, the scorers and the threshold you choose. This page covers those choices; [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) runs the loop end to end.

## The dataset

The dataset is the specification: an agent that passes it is correct only in the sense its items define.

- **Weight it toward failures.** A set sampled uniformly from production is dominated by turns the agent already answers. Its pass rate sits near `1.0`, and a regression moves it by one item. Favour turns that went wrong, edge cases, and requests the agent must refuse.
- **Fix the reference when curating.** `create-dataset-item-from-generation` copies the turn's answer into `expected_output`. For a turn promoted _because_ it was wrong, that stores the defect as the reference: pass `--expected-output` with the correct answer, or `null` when the scorers need none. See [Curating items from production](../modules/evaluations.md#curating-items-from-production) and [Replay a Bad Turn](/docs/tutorials/replay-a-bad-turn).
- **Size it for the change you want to see.** One item is `1 / N` of the pass rate. At 20 items a one-item swing is `0.05`, so a change smaller than that is invisible, and a change of that size is indistinguishable from [noise](#noise-before-signal).

### Label each item's kind

Put the kind in `metadata` (`{"kind": "refusal"}`, `{"kind": "multi_step"}`). A run aggregates per scorer, never per kind, and an overall pass rate hides a kind that collapsed.

A scorer that applies to one kind reads `item.metadata` and passes the others vacuously:

```json
{
  "type": "json_logic",
  "expression": {
    "if": [
      { "==": [{ "var": "item.metadata.kind" }, "refusal"] },
      { "in": ["cannot", { "var": "output" }] },
      true
    ]
  }
}
```

An item passes when every scorer passes, so the vacuous `true` costs no other kind its verdict; it does inflate that scorer's own `mean` and `pass_rate`. To read a pass rate per kind, list the run's results, join `dataset_item_id` to each item's `metadata`, and group client-side. When kinds need different thresholds, give each its own dataset and eval.

## Choosing a scorer

Use the cheapest scorer that decides the item.

| The output is right when | Scorer | Extra calls per item | Repeatable |
| --- | --- | --- | --- |
| One string is correct (a label, an id) | `exact_match` | none | yes |
| A phrase or fact must appear | `contains` | none | yes |
| A rule over output, structured object, input or metadata holds | `json_logic` | none | yes |
| The structured output has the required shape | `output_schema` | none | yes |
| It paraphrases a reference answer | `embedding_similarity` | embeddings | per embedding model |
| Quality has no reference string (tone, helpfulness, faithfulness) | `llm_judge` | one completion | no |
| A business rule needs code or data (totals add up, an id exists) | `tool` | one tool call | as your code |

- **Decompose before you judge.** "Mentions the 30-day refund window" is a `contains`, not a judge. Keep `llm_judge` for criteria no rule decides.
- **Every scorer narrows.** An item's verdict is the AND of its scorers, so a judge bound alongside a `contains` only ever fails items the `contains` passed.
- **`output_schema` needs the agent's own `output_schema`**; without it the scorer is refused ([Scorers](../modules/evaluations.md#scorers)).

## Noise before signal

Agents are stochastic: two runs of one version over one dataset do not produce one pass rate. A delta means nothing until you know how far the figure moves on its own.

1. Run the unchanged version twice, the second with `baseline_run_id` naming the first. That run's `pass_rate_delta` is noise. Repeat a few times; the largest absolute delta is your **noise floor**.
2. A change is signal only when its delta exceeds the floor. Below it, run again or add items.
3. Set `pass_threshold` below the current version's pass rate minus the floor. A threshold of `1.0` fails on noise.

Measure the agent at the `temperature` production serves. Temperature is part of the [agent version](../modules/agents.md#versioning-and-staged-rollout); an eval-only setting measures a different agent.

### Reading a run

- **Compare deltas, not raw pass rates.** [Baseline deltas](../modules/evaluations.md#baseline-deltas) are computed over the items both runs scored (`compared_item_count`); a run's own `pass_rate` includes items added since. Nonzero `added_item_count` or `removed_item_count` means the dataset moved under you.
- **Read `errored_count` next to `passed`.** The pass rate is passed items over _non-errored_ items, and the verdict does not read the error count: a run whose items mostly errored passes on the few that scored ([Errors are not zeros](../modules/evaluations.md#errors-are-not-zeros)). Check it before promoting on a run.

## Calibrating a judge

An `llm_judge` or `embedding_similarity` score is a model's opinion; its `pass_threshold` means nothing until it agrees with human grades.

1. Grade 20–30 items by hand, pass or fail, borderline cases included.
2. Run the eval and list the results; compare each scorer's `passed` with your grade.
3. Move the threshold or rewrite the prompt until the disagreements are few and understood. The judge's `reasoning` on each one says which of the two is wrong.

For an `llm_judge` ([LLM judge](../modules/evaluations.md#llm-judge)):

- **Pin `ai_provider_id` and `model`.** A judge that pins none follows the project's default model route, so changing the default changes every score and breaks comparison with past runs.
- **Write the rubric into the prompt**: what `1.0`, `0.5` and `0` mean for this criterion. A judge asked for "a score" drifts toward the top.
- **Grade against `{{expected}}`** when a reference exists; it is more repeatable than grading in the abstract.
- **Judge with a different model than the agent's.** Models tend to rate their own output higher.

For `embedding_similarity`, calibrate on your own data and re-run the baseline whenever `EMBEDDING_MODEL` changes ([Embedding similarity](../modules/evaluations.md#embedding-similarity)).

## Overfitting to the dataset

A prompt tuned until the dataset passes has learned the dataset. Keep two:

| Set | Use |
| --- | --- |
| **dev** | Iterate against it and read every failing item |
| **held-out** | Never read while tuning; bound to the eval that is the release's [`promotion_gate`](../modules/agents.md#eval-gated-promotion) |

A change that lifts dev and leaves held-out flat fit the items, not the task. Refresh held-out from production; an item you read while tuning moves to dev.

## Cost and side effects

A run costs `items × (agent generation + one judge completion per llm_judge + one call per tool scorer)`. Eval spend is metered apart from production ([Eval spend](../modules/evaluations.md#eval-spend-is-separable-from-production-spend)); read it before scheduling a suite nightly. Every item is a real generation, so a write-capable tool performs real writes: point the agent's tools, and any `tool` scorer with side effects, at staging.

## Checklist

- [ ] Dataset weighted toward failures, each item's kind in `metadata`
- [ ] Curated items carry a correct `expected_output`
- [ ] The cheapest scorer per criterion; `llm_judge` only where no rule decides
- [ ] Noise floor measured; `pass_threshold` below the current pass rate minus the floor
- [ ] Judge model pinned and threshold calibrated against human grades
- [ ] `errored_count` read before trusting `passed`
- [ ] A held-out set behind the promotion gate
