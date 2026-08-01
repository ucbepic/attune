import json
from collections import defaultdict

from src.utils.client import invoke_llm_with_schema

MAX_FEATURES = 80
MIN_EDGE_COUNT = 2

distill_schema = {
    "name": "distill_criteria_response",
    "schema": {
        "type": "object",
        "properties": {
            "criteria": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Short canonical name (2-5 words, Title Case)"
                        },
                        "type": {
                            "type": "string",
                            "enum": ["boolean", "integer"],
                            "description": "boolean for yes/no properties; integer ONLY for objectively countable/measurable quantities"
                        },
                        "definition": {
                            "type": "string",
                            "description": "Clear evaluation prompt. For boolean: true = higher score. For integer: higher value = higher score. Must specify exactly what to evaluate/count."
                        },
                        "importance_rank": {
                            "type": "integer",
                            "description": "1 = most important, ascending"
                        },
                        "raw_features_absorbed": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Raw feature names from the input that this criterion covers"
                        },
                        "estimated_coverage": {
                            "type": "number",
                            "description": "Fraction of comparison edges this criterion helps explain (0.0 to 1.0)"
                        }
                    },
                    "required": ["name", "type", "definition", "importance_rank",
                                 "raw_features_absorbed", "estimated_coverage"]
                }
            }
        },
        "required": ["criteria"]
    }
}


def _aggregate_feature_stats(comparison_graph, scores):
    stats = defaultdict(lambda: {"edge_count": 0, "score_gaps": [], "favors_higher_count": 0})

    for id_a, id_b, choice, confidence, dist_feats, unif_feats in comparison_graph:
        score_a = scores.get(id_a)
        score_b = scores.get(id_b)

        for f in dist_feats:
            f = f.strip()
            if not f:
                continue
            stats[f]["edge_count"] += 1
            if score_a is not None and score_b is not None:
                gap = abs(score_a - score_b)
                stats[f]["score_gaps"].append(gap)
                if choice == "A" and score_a > score_b:
                    stats[f]["favors_higher_count"] += 1
                elif choice == "B" and score_b > score_a:
                    stats[f]["favors_higher_count"] += 1

        for f in unif_feats:
            f = f.strip()
            if not f:
                continue
            stats[f]["edge_count"] += 1
            if score_a is not None and score_b is not None:
                gap = abs(score_a - score_b)
                stats[f]["score_gaps"].append(gap)

    result = {}
    for feat, s in stats.items():
        avg_gap = sum(s["score_gaps"]) / len(s["score_gaps"]) if s["score_gaps"] else 0
        favors_higher = s["favors_higher_count"] / max(s["edge_count"], 1)
        result[feat] = {
            "edge_count": s["edge_count"],
            "avg_score_gap": round(avg_gap, 2),
            "favors_higher": round(favors_higher, 2)
        }

    return result


def _filter_and_rank_features(feature_stats):
    filtered = {f: s for f, s in feature_stats.items() if s["edge_count"] >= MIN_EDGE_COUNT}

    ranked = sorted(filtered.items(), key=lambda x: x[1]["edge_count"] * x[1]["avg_score_gap"], reverse=True)

    return ranked[:MAX_FEATURES]


def distill_criteria(comparison_graph, scores, task, min_score, max_score, top_fraction=0.3):
    total_edges = len(comparison_graph)

    feature_stats = _aggregate_feature_stats(comparison_graph, scores)
    print(f"Found {len(feature_stats)} unique raw features")

    if not feature_stats:
        return [], comparison_graph, 0

    ranked_features = _filter_and_rank_features(feature_stats)
    print(f"After filtering (edge_count >= {MIN_EDGE_COUNT}): {len(ranked_features)} features")

    if not ranked_features:
        ranked_features = sorted(feature_stats.items(),
                                 key=lambda x: x[1]["edge_count"], reverse=True)[:MAX_FEATURES]

    top_k = max(3, min(15, round(len(ranked_features) * top_fraction)))

    features_block = []
    for feat, s in ranked_features:
        features_block.append(
            f"- \"{feat}\" (appears in {s['edge_count']}/{total_edges} edges, "
            f"avg score gap: {s['avg_score_gap']}, favors higher-scored: {s['favors_higher']:.0%})"
        )
    features_text = "\n".join(features_block)

    prompt = f"""You are analyzing scoring criteria for the following task:

Task: {task}
Score range: {min_score} to {max_score}

Below are {len(ranked_features)} raw features extracted from {total_edges} pairwise comparisons, ranked by impact. Each feature includes:
- How many comparison edges mention it
- The average score difference between compared items when this feature appears
- How often this feature favors the higher-scored item

Raw features (ranked by impact):
{features_text}

Synthesize exactly {top_k} scoring criteria from these features. Requirements:

1. IMPORTANCE: Rank criteria from most to least important (importance_rank 1 = most important).
2. DIVERSITY: No two criteria should overlap significantly. Each should capture a distinct aspect.
3. MONOTONICITY: Every criterion MUST have a monotonic relationship with the score:
   - For boolean criteria: true means the item should score HIGHER.
   - For integer criteria: a higher value means the item should score HIGHER.
   The definition must clearly reflect this direction.
4. GENERALIZABILITY: Criteria should apply to any item for this task, not just the observed sample.
5. COVERAGE: Collectively, the {top_k} criteria should explain as many comparison outcomes as possible.
6. ABSORPTION: Each criterion should absorb multiple related raw features where appropriate. List ALL raw features that map to each criterion.
7. TYPES:
   - "integer" ONLY for concrete, objectively countable/measurable quantities (e.g., word count, number of examples).
   - "boolean" for inherently yes/no properties. Do NOT create subjective rating criteria like "Quality Score" or "Clarity Level".

For each criterion, estimate what fraction of the {total_edges} comparison edges it helps explain (estimated_coverage, 0.0 to 1.0)."""

    content, _, cost = invoke_llm_with_schema(
        prompt=prompt,
        response_schema=distill_schema,
        temperature=0.3
    )

    result = json.loads(content)
    criteria_raw = result.get("criteria", [])

    criteria_raw.sort(key=lambda c: c.get("importance_rank", 999))

    feature_to_criterion = {}
    for c in criteria_raw:
        for raw in c.get("raw_features_absorbed", []):
            feature_to_criterion[raw.strip()] = c["name"]

    clean_criteria = []
    for c in criteria_raw:
        clean_criteria.append({
            "name": c["name"],
            "text": c["name"],
            "type": c["type"],
            "definition": c["definition"],
            "importance_rank": c.get("importance_rank", 0),
            "coverage": c.get("estimated_coverage", 0)
        })

    print(f"Distilled {len(clean_criteria)} criteria:")
    for c in clean_criteria:
        print(f"  #{c['importance_rank']} [{c['type']}] {c['name']} (coverage: {c['coverage']:.0%}): {c['definition'][:80]}...")

    absorbed_features = set()
    for c in criteria_raw:
        for raw in c.get("raw_features_absorbed", []):
            absorbed_features.add(raw.strip().lower())

    other_criteria = []
    for feat, s in ranked_features:
        if feat.strip().lower() not in absorbed_features:
            other_criteria.append({
                "name": feat.strip(),
                "edge_count": s["edge_count"],
                "total_edges": total_edges,
                "avg_score_gap": s["avg_score_gap"],
                "favors_higher": s["favors_higher"]
            })

    print(f"Other criteria (not selected): {len(other_criteria)}")

    reannotated_comparisons = []
    for id_a, id_b, choice, confidence, dist_feats, unif_feats in comparison_graph:
        new_dist = list(set(
            feature_to_criterion.get(f.strip(), f.strip())
            for f in dist_feats if f and f.strip()
        ))
        new_unif = list(set(
            feature_to_criterion.get(f.strip(), f.strip())
            for f in unif_feats if f and f.strip()
        ))
        reannotated_comparisons.append((id_a, id_b, choice, confidence, new_dist, new_unif))

    return clean_criteria, reannotated_comparisons, cost, other_criteria
