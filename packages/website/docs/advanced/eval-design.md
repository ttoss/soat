---
description: 'How to design an eval whose verdict means something: a dataset weighted toward failures, the cheapest scorer that decides each item, a delta read against its p-value and interval before it is trusted, judges calibrated against human grades, and a held-out set behind the promotion gate.'
keywords:
  - eval design
  - evaluation dataset
  - llm judge calibration
  - noise floor
  - held-out set
---

# Eval Design

[Evaluations](../modules/evaluations.md) guarantees the mechanics: every item runs against the real agent, inputs are frozen, one version is pinned, errors are counted apart. What a verdict _means_ is decided by the items, the scorers and the threshold you choose. This page covers those choices and shows no calls: new to evals, complete [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) first, which builds a dataset, binds scorers, runs the eval and compares two runs.

## The dataset

The dataset is the specification: an agent that passes it is correct only in the sense its items define.

- **Weight it toward failures.** A set sampled uniformly from production is dominated by turns the agent already answers. Its pass rate sits near `1.0`, and a regression moves it by one item. Favour turns that went wrong, edge cases, and requests the agent must refuse.
- **Fix the reference when curating.** `create-dataset-item-from-generation` copies the turn's answer into `expected_output`. For a turn promoted _because_ it was wrong, that stores the defect as the reference: pass `--expected-output` with the correct answer, or `null` when the scorers need none. See [Curating items from production](../modules/evaluations.md#curating-items-from-production) and [Replay a Bad Turn](/docs/tutorials/replay-a-bad-turn).
- **Size it for the change you want to see.** One item is `1 / N` of the pass rate. At 20 items a one-item swing is `0.05`, so a change smaller than that is invisible, and a change of that size is indistinguishable from [noise](#noise-before-signal).

### Label each item's kind

Put the kind in `metadata` (`{"kind": "refusal"}`, `{"kind": "multi_step"}`) and set the eval's `group_by` to `kind`. An overall pass rate hides a kind that collapsed; `aggregate_scores.grouping` reports each kind's pass rate beside it, and `baseline.grouping` each kind's delta ([Grouped aggregates](../modules/evaluations.md#grouped-aggregates)).

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

An item passes when every scorer passes, so the vacuous `true` costs no other kind its verdict; it does inflate that scorer's own `mean` and `pass_rate` in the run and in every other kind's group, so read it inside its own kind's group ([Grade Structured Output with Your Own Scorer — Step 8](/docs/tutorials/grade-structured-output-with-your-own-scorer#step-8--read-the-pass-rate-per-kind)). The verdict gates on the run's pass rate only: when kinds need different thresholds, give each its own dataset and eval.

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
| Production already asks the question (a decider reviews live output) | `decider` | one decision | as its backend |

- **Decompose before you judge.** "Mentions the 30-day refund window" is a `contains`, not a judge. Keep `llm_judge` for criteria no rule decides.
- **Every scorer narrows.** An item's verdict is the AND of its scorers, so a judge bound alongside a `contains` only ever fails items the `contains` passed.
- **`output_schema` needs the agent's own `output_schema`**; without it the scorer is refused ([Scorers](../modules/evaluations.md#scorers)).
- **Reuse the decider production asks.** A `decider` scorer grades with the same versioned questions as every other caller of that decider, so the eval cannot drift from what is enforced ([Decider scorers](../modules/evaluations.md#decider-scorers-decider)).

[Grade Structured Output with Your Own Scorer](/docs/tutorials/grade-structured-output-with-your-own-scorer) binds `output_schema`, `json_logic` and `tool` on one eval; [Grade an Eval with a Decider](/docs/tutorials/grade-an-eval-with-a-decider) binds a `decider`.

## Noise before signal

Agents are stochastic, and a dataset is a sample: two runs of one version over one dataset do not produce one pass rate. Every run reports how far its figures move on their own ([Evaluations — Uncertainty](../modules/evaluations.md#uncertainty)).

1. **Read `baseline.p_value` before the delta.** Run the change with `baseline_run_id` naming the current version's run ([Evaluate an Agent — Step 6](/docs/tutorials/evaluate-an-agent#step-6--fix-the-prompt-then-measure-the-fix)). A delta whose `p_value` is above `0.05` is not yet distinguishable from items flipping at random: run again or add items. Read `flipped` beside it: `9` improved against `6` regressed is a different change from `3` against `0`.
2. **Read it per kind.** With `group_by` set, each `baseline.grouping.groups` entry has its own `p_value`, and a kind that regressed can be significant while the overall delta is not.
3. **Set `pass_threshold` below the current version's `pass_rate_interval.low`.** A threshold inside the interval passes or fails on which items the model happened to get right. A threshold of `1.0` fails on noise.
4. **Size the dataset by the interval.** When `pass_rate_interval` is wider than the change you need to see, no delta can show it: add items, weighted toward failures.

Measure the agent at the `temperature` production serves. Temperature is part of the [agent version](../modules/agents.md#versioning-and-staged-rollout); an eval-only setting measures a different agent.

### Reading a run

- **Compare deltas, not raw pass rates.** [Baseline deltas](../modules/evaluations.md#baseline-deltas) are computed over the items both runs scored (`compared_item_count`); a run's own `pass_rate` includes items added since. Nonzero `added_item_count` or `removed_item_count` means the dataset moved under you.
- **Read `errored_count` next to `passed`.** The pass rate is passed items over _non-errored_ items, and the verdict does not read the error count: a run whose items mostly errored passes on the few that scored ([Errors are not zeros](../modules/evaluations.md#errors-are-not-zeros)). Check it before promoting on a run.
- **Match `decider_versions` across the two runs.** A run pins each decider's version, and a baseline graded under another version is still compared: a delta across versions moves the criteria, not only the agent.

## Calibrating a judge

An `llm_judge` or `embedding_similarity` score is a model's opinion; its `pass_threshold` means nothing until it agrees with human grades.

1. Grade 20–30 items by hand, pass or fail, borderline cases included.
2. Run the eval and compare each scorer's `passed` with your grade ([Judge Open-Ended Answers — Step 5](/docs/tutorials/judge-open-ended-answers#step-5--check-the-judge-against-your-own-grades)).
3. Move the threshold or rewrite the prompt until the disagreements are few and understood. The judge's `reasoning` on each one says which of the two is wrong.

For an `llm_judge` ([LLM judge](../modules/evaluations.md#llm-judge)):

- **Pin `ai_provider_id` and `model`.** A judge that pins none follows the project's default model route, so changing the default changes every score and breaks comparison with past runs.
- **Write the rubric into the prompt**: what `1.0`, `0.5` and `0` mean for this criterion. A judge asked for "a score" drifts toward the top.
- **Grade against `{{expected}}`** when a reference exists; it is more repeatable than grading in the abstract.
- **Judge with a different model than the agent's.** Models tend to rate their own output higher.

For a `decider`, calibrate its `score` expression and `pass_threshold` the same way; the pinned decider version is what stays fixed between runs.

For `embedding_similarity`, calibrate on your own data and re-run the baseline whenever `EMBEDDING_MODEL` changes ([Embedding similarity](../modules/evaluations.md#embedding-similarity)).

## Overfitting to the dataset

A prompt tuned until the dataset passes has learned the dataset. Keep two:

| Set | Use |
| --- | --- |
| **dev** | Iterate against it and read every failing item |
| **held-out** | Never read while tuning; bound to the eval that is the release's [`promotion_gate`](../modules/agents.md#eval-gated-promotion) |

A change that lifts dev and leaves held-out flat fit the items, not the task. Refresh held-out from production; an item you read while tuning moves to dev.

## Cost and side effects

A run costs `items × (agent generation + one judge completion per llm_judge + one call per tool scorer + one decision per decider scorer)`. Eval spend is metered apart from production ([Eval spend](../modules/evaluations.md#eval-spend-is-separable-from-production-spend)); read it before scheduling a suite nightly. Every item is a real generation, so a write-capable tool performs real writes: point the agent's tools, and any `tool` scorer with side effects, at staging.

## Checklist

- [ ] Dataset weighted toward failures, each item's kind in `metadata`, `group_by` set to it
- [ ] Curated items carry a correct `expected_output`
- [ ] The cheapest scorer per criterion; `llm_judge` only where no rule decides
- [ ] Deltas read with `baseline.p_value`, overall and per kind; `pass_threshold` below the current `pass_rate_interval.low`
- [ ] Judge model pinned, decider versions matched across compared runs, thresholds calibrated against human grades
- [ ] `errored_count` read before trusting `passed`
- [ ] A held-out set behind the promotion gate
