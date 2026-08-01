import json
from concurrent.futures import ThreadPoolExecutor, as_completed

from src.utils.client import invoke_llm_with_schema

BATCH_SIZE = 10
MAX_WORKERS = 1

batch_comparison_schema = {
    "name": "batch_comparison_response",
    "schema": {
        "type": "object",
        "properties": {
            "comparisons": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "pair_index": {
                            "type": "integer",
                            "description": "0-based index of the pair in the batch"
                        },
                        "choice": {
                            "type": "string",
                            "enum": ["A", "B", "="],
                            "description": "A if Input A is clearly better, B if Input B is clearly better, = if they are similar or equivalent"
                        },
                        "distinguishing_features": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "If A or B was chosen: list of 1-2 word key factors that make the winner better than the loser. Leave empty if choice is =."
                        },
                        "unifying_features": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "If = was chosen: list of 1-2 word key factors that both inputs share, making them equivalent. Leave empty if choice is A or B."
                        }
                    },
                    "required": ["pair_index", "choice", "distinguishing_features", "unifying_features"]
                }
            }
        },
        "required": ["comparisons"]
    }
}


def _build_batch_prompt(pairs_data, comparison_prompt, task):
    pairs_text_parts = []
    for pair_idx, A, B in pairs_data:
        A_str = json.dumps(A, indent=2)
        B_str = json.dumps(B, indent=2)
        pairs_text_parts.append(
            f"--- Pair {pair_idx} ---\n"
            f"Input A:\n{A_str}\n\n"
            f"Input B:\n{B_str}"
        )

    pairs_block = "\n\n".join(pairs_text_parts)

    prompt = f"""You are a comparison judge. For each pair below, decide which input is preferred based on the task and comparison criteria, or determine that they are similar.

Task: {task}

Comparison Criteria:
{comparison_prompt}

For EACH pair, provide:
- "choice": "A" if Input A is clearly better, "B" if Input B is clearly better, or "=" if both inputs are similar or equivalent for this task. Only choose A or B when there is a meaningful difference — if the inputs are comparable in quality, choose "=".
- If you chose A or B, provide "distinguishing_features": a list of ALL key factors (each 1-3 words) that make the chosen input better. Be thorough — list every meaningful reason the winner is preferred. Leave "unifying_features" as an empty list.
- If you chose =, provide "unifying_features": a list of ALL key factors (each 1-3 words) that both inputs share, explaining why they are equivalent. Be thorough. Leave "distinguishing_features" as an empty list.

{pairs_block}

Respond with a JSON object containing a "comparisons" array with one entry per pair, in order."""

    return prompt


def _compare_batch(pairs_data, comparison_prompt, task):
    prompt = _build_batch_prompt(pairs_data, comparison_prompt, task)

    last_exc = None
    cost = 0.0
    for _attempt in range(3):
        content, _, call_cost = invoke_llm_with_schema(
            prompt=prompt,
            response_schema=batch_comparison_schema,
            temperature=0.0
        )
        cost += call_cost
        try:
            result = json.loads(content)
            break
        except (json.JSONDecodeError, KeyError) as e:
            last_exc = e
            result = None
    if result is None:
        print(f"      WARNING: batch parse failed after 3 retries ({last_exc}); defaulting to '='")
        return [(pair_idx, "=", 0.5, [], ["parse_error"]) for pair_idx, _, _ in pairs_data], cost

    comparisons = result.get("comparisons", [])

    by_index = {}
    for comp in comparisons:
        by_index[comp["pair_index"]] = comp

    outputs = []
    for pair_idx, A, B in pairs_data:
        comp = by_index.get(pair_idx)
        if comp is None:
            outputs.append((pair_idx, "=", 0.5, [], ["Unknown"]))
            continue

        choice = comp["choice"].strip().upper()
        dist_features = [f.strip() for f in comp.get("distinguishing_features", []) if f.strip()]
        unif_features = [f.strip() for f in comp.get("unifying_features", []) if f.strip()]

        if choice in ("A", "B"):
            confidence = 1.0
            unif_features = []
        else:
            choice = "="
            confidence = 0.5
            dist_features = []

        outputs.append((pair_idx, choice, confidence, dist_features, unif_features))

    return outputs, cost


def perform_batched_comparisons(all_pairs, comparison_prompt, task, batch_size=BATCH_SIZE, max_workers=MAX_WORKERS, progress_callback=None):
    total = len(all_pairs)
    if total == 0:
        return [], 0

    batches = []
    for batch_start in range(0, total, batch_size):
        batch_end = min(batch_start + batch_size, total)
        batch_pairs = []
        for i in range(batch_start, batch_end):
            id_a, id_b, A, B = all_pairs[i]
            batch_pairs.append((i, A, B))
        batches.append((batch_start, batch_pairs))

    id_map = {i: (all_pairs[i][0], all_pairs[i][1]) for i in range(total)}

    comparison_graph = [None] * total
    total_cost = 0
    comparisons_done = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {}
        for batch_start, batch_pairs in batches:
            future = executor.submit(_compare_batch, batch_pairs, comparison_prompt, task)
            futures[future] = batch_start

        for future in as_completed(futures):
            outputs, cost = future.result()
            total_cost += cost

            for pair_idx, choice, confidence, dist_feats, unif_feats in outputs:
                id_a, id_b = id_map[pair_idx]
                comparison_graph[pair_idx] = (id_a, id_b, choice, confidence, dist_feats, unif_feats)
                comparisons_done += 1

            if progress_callback:
                progress_callback(comparisons_done, total)

    comparison_graph = [c for c in comparison_graph if c is not None]

    return comparison_graph, total_cost
