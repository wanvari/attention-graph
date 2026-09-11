# Embedding context audit — September 11, 2026

Production models remain BGE-M3 and Qwen3:4b. No model weights, prompts, embedding inputs, grouping thresholds, capture timing, or inference runtime defaults were changed. The experimental code is under `tools/` and its synthetic recording under `fixtures/context/`; neither is in the release runtime allowlist. It never opens browser history or IndexedDB.

## What the current code actually uses

| Stage | Current behavior | Consequence |
| --- | --- | --- |
| Extraction | Retains up to 8,000 text characters. Very long chats retain the first 2,000 plus the final roughly 6,000. Existing traversal/privacy limits apply. | This is a retained sample, not the entire page or conversation. `textLength` describes observed source length and can exceed retained length. |
| Embedding selection | Ordinary pages use the first 1,500 body characters. Chats use first 900 plus last 600 when longer than 1,500. Title/domain are added. | Useful material in the middle or later in an article can be omitted. |
| Client transport | Caps the complete embedding input at 2,000 characters. Sends no explicit embedding context/token-batch capacity. | Increasing only the earlier selection would still cut the request. The chat 8,192-token setting does not configure embedding calls. |
| Cache key | Model tag plus a hash of the first 2,000 input characters. | A longer-input implementation also needs a new full-input key and preprocessing version. Otherwise a change beyond the old prefix can reuse an old vector. |
| Refresh | Chat embeddings can reuse the old vector while observed text remains below 8,000 characters and growth stays at or below 30% of the last retained embedded-text length. | Same-length edits or subject changes need not trigger a new embedding. A captured change and an embedded change are different events. |
| Labeling | At most four representative pages, with 120 body characters per page plus title/URL and keywords. | Giving the embedding more text does not automatically give the labeler more evidence. |
| Adjudication | Two page orders, using titles and domains; no page body text. Runs only when MIXED/weak/cohesion gates trigger. | Common boilerplate or bland titles can remain a misleading group without triggering this check. |

Source: `content/capture.js`, `lib/pipeline.js`, `lib/ollama.js`, `lib/label.js`, `lib/adjudicate.js`. Input characterization tests demonstrate captured middle edits producing unchanged production inputs/cache keys.

## A runtime limit beyond the advertised context window

The [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) specifies 8,192 tokens and 1,024-dimensional vectors; the installed model reports those same values. [Ollama's embedding API](https://docs.ollama.com/api/embed) permits disabling truncation so an oversized request fails rather than silently losing text.

On installed Ollama 0.33.3, one synthetic 8,068-character input produced these results:

| Request | Result |
| --- | --- |
| Default runtime; truncation disabled | HTTP 400 |
| `num_ctx:8192`; truncation disabled | HTTP 400 |
| `num_ctx:8192`; truncation allowed | Success, 2,048 processed tokens |
| `num_ctx:8192,num_batch:4096`; truncation disabled | Success, all 2,070 processed tokens |

The reported running context changed from 4,096 to 8,192, but that alone did not fix the rejection. The [installed-version server code](https://github.com/ollama/ollama/blob/v0.33.3/server/routes.go#L870) retries embedding failures by truncating to the token-batch limit when truncation is allowed. This is distinct from the extension's batch of eight pages. The capacity probe reproduces all four outcomes; see [raw report](context-capacity-2026-09-11.json).

Consequently, the full-retained-text experiment explicitly requests the larger context and token batch and disables truncation. Both failed attempts remain documented; they are not counted as successful full-text runs. This is a necessary runtime adjustment to test complete input, not a production change or a model replacement.

## Evaluation design and limits

The reproducible corpus has 76 synthetic pages: 40 ordinary fixture pages, 8 with late evidence, 8 chats with evidence in the middle, 8 long ordinary pages, 4 mixed-subject chats, 4 mixed-source pages and 4 brief status pages. All four status pages fail the existing measured-evidence gate before embedding; 72 pages reach the model. Long challenge pages repeat existing fixture prose and neutral framing, deliberately stressing sampling. This is not an estimate of real-world application accuracy and is not comparable to the earlier 28-day fixture's headline precision.

Three profiles use the same model weights: current selection, up to 4,000 body characters (chat head/tail selection), and all retained body text up to 8,000 characters. Models, clustering thresholds, label/adjudication prompts and 12-topic run budget stay fixed. Full text additionally requires the verified runtime capacity settings above. No labels or expected topics are passed to the models. Measurements cover embedding, clustering, labeling and conditional adjudication; they do not exercise registry attachment, capture refresh, or the complete history pipeline. Label wording is recorded, not human-scored.

Correct and incorrect grouped pairs, missed same-topic pairs, noise inclusion, per-case coverage, and budget deferrals are reported separately. Raw clustering is scored before the topic budget; final groups are also scored afterward. Ordinary pages can be contaminated by a mixed-subject page even when their own inputs are good. One supported pure group requires at least two pages; a singleton is not counted as a supported match.

## Measured results

| Profile | Wrong grouped pairs | Missed same-topic pairs | Noise pages grouped | Topic-budget deferrals | Total stage time | Peak sampled model residency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| current | 136 | 96 | 7/12 | 1 | 94.5s | 3.54 GiB |
| expanded4000 | 136 | 96 | 7/12 | 1 | 104.4s | 3.59 GiB |
| full8000 | 32 | 0 | 8/12 | 0 | 108.6s | 3.59 GiB |

All 64 clear-topic pages are grouped under all three policies, but the groups differ. The full-text profile recovers all 224 expected same-topic pairs and removes the misleading common-framing group. The 4,000-character policy produces different vectors but the same partition as the current policy; its extra text still leaves framing prominent in the challenge examples.

**This is not a no-regression result.** All four mixed-subject chats still attach to one topic. Their incorrect pairings increase from 24 to 32 as the now-recovered late/middle pages join those same topics. The net reduction in wrong pairs (136 → 32) must not hide that remaining failure. Raw clustering groups 8 noise pages under every profile; the final 7 → 8 difference comes from the 12-topic budget deferring one noise singleton in the smaller-input runs, not from newly admitting a previously rejected page. All four brief status pages remain excluded.

No adjudication call triggered in any profile: the resulting groups looked cohesive to the current gate and none received MIXED. This is evidence of a gap in the gate on these examples, not validation that the adjudicator would resolve them. Body text is absent from its current prompt.

Recorded embedding-stage wall times, including pacing, were 31.5s / 42.9s / 53.8s. Total stage times also include labels and unloading. These are single runs, with successful earlier profiles reused after the failed full-text attempts; they are not repeated controlled latency estimates. Sampled residency is the sum of the two relevant models reported by Ollama after requests, not whole-application RAM. No model overlap was sampled.

Decision: **keep production input and model settings unchanged.** Full retained context is promising with the same models, but a future rollout needs better mixed-subject handling and the cache/refresh work below. This audit does not justify a smaller model.

Reproduce: `npm run check:context` (live local models), `npm run replay:context` (offline exact requests/responses), and `npm run check:context-capacity` (four local capacity probes). `--live --resume` retains completed profiles after interruption; changed corpora or recorded model digests fail instead of silently mixing results. The complete compressed recording contains 33 requests and model responses across three profiles. [Raw experiment](context-2026-09-11.json), [capacity probe](context-capacity-2026-09-11.json).

## What a future production context change requires

1. Preserve the current production behavior as the baseline. Do not promote an input policy based on this synthetic set alone.
2. Hash the actual complete input, model identity/digest and preprocessing version; re-embed deliberately in an isolated registry generation rather than silently mixing old/new representations. Raw records and user corrections must survive rollback.
3. Make captured, retained and embedded text lengths/hashes distinct. Test same-length edits, growing chats and source-text expiration before changing the refresh policy.
4. Verify token capacity with truncation disabled and bounded batches on each supported runtime. Character count alone cannot establish token fit, especially across languages.
5. Evaluate relevant body evidence for labels/adjudication and resistance to common page framing. Longer embeddings alone cannot repair missing evidence in those stages.
6. Before rollout, use independently reviewed pages, mixed-topic examples, multiple languages, existing-registry attachment and repeated runs. Require no regression in incorrect merges/noise as well as checking coverage, label correctness, timing integrity and laptop residency.
