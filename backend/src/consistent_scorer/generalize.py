import json
import numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from ..utils.client import invoke_llm_with_schema

MAP_BATCH_SIZE = 10
MAX_WORKERS = 1


def _build_map_schema(criteria):
    properties = {}
    for c in criteria:
        if c["type"] == "integer":
            properties[c["name"]] = {
                "type": "integer",
                "description": c["definition"]
            }
        else:
            properties[c["name"]] = {
                "type": "boolean",
                "description": c["definition"]
            }

    required = [c["name"] for c in criteria]

    return {
        "name": "map_features_response",
        "schema": {
            "type": "object",
            "properties": {
                "evaluations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "The id of the input item"
                            },
                            "features": {
                                "type": "object",
                                "properties": properties,
                                "required": required
                            }
                        },
                        "required": ["id", "features"]
                    }
                }
            },
            "required": ["evaluations"]
        }
    }


def _build_criteria_description(criteria):
    parts = []
    for c in criteria:
        type_hint = "true/false" if c["type"] == "boolean" else "integer — count or measure the concrete quantity described (higher = better)"
        parts.append(f"- {c['name']} ({type_hint}): {c['definition']}")
    return "\n".join(parts)


def _map_batch(criteria, batch_rows, schema):
    criteria_desc = _build_criteria_description(criteria)

    items_parts = []
    batch_ids = []
    for row in batch_rows:
        batch_ids.append(row["id"])
        items_parts.append(f"Item (id: {row['id']}):\n{json.dumps(row, indent=2)}")

    items_block = "\n\n".join(items_parts)

    prompt = f"""Evaluate each item below against the scoring criteria listed. For each item, provide a value for every criterion.

CRITERIA:
{criteria_desc}

ITEMS:
{items_block}

For each item, respond with its id and a "features" object containing a value for every criterion.
- For boolean criteria: answer true or false based on the definition.
- For integer criteria: count or measure the specific quantity described in the definition. These must be objective counts/measurements extracted from the data, NOT subjective scores or ratings you assign.
Be consistent across items."""

    content, _, cost = invoke_llm_with_schema(
        prompt=prompt,
        response_schema=schema,
        temperature=0.3
    )

    result = json.loads(content)
    evaluations = result.get("evaluations", [])

    mapped = {}
    by_id = {str(e["id"]): e["features"] for e in evaluations}

    for row_id in batch_ids:
        features = by_id.get(str(row_id))
        if features:
            mapped[row_id] = features
        else:
            pass

    if len(mapped) < len(batch_ids):
        for i, row_id in enumerate(batch_ids):
            if row_id not in mapped and i < len(evaluations):
                mapped[row_id] = evaluations[i]["features"]

    return mapped, cost


def map_features(criteria, inputs):
    if not criteria or not inputs:
        return {}, 0

    total_cost = 0
    mapped_features = {}
    schema = _build_map_schema(criteria)

    batches = [inputs[i:i + MAP_BATCH_SIZE] for i in range(0, len(inputs), MAP_BATCH_SIZE)]

    if len(batches) == 1:
        mapped, cost = _map_batch(criteria, batches[0], schema)
        total_cost += cost
        mapped_features.update(mapped)
    else:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(_map_batch, criteria, batch, schema): i
                       for i, batch in enumerate(batches)}

            for future in as_completed(futures):
                mapped, cost = future.result()
                total_cost += cost
                mapped_features.update(mapped)

    print(f"Mapped features for {len(mapped_features)}/{len(inputs)} items")
    return mapped_features, total_cost


def learn_rules(scores, mapped_features, min_score=1, max_score=10):
    if not scores or not mapped_features:
        return []

    common_ids = sorted(set(scores.keys()) & set(mapped_features.keys()))
    if len(common_ids) < 2:
        return []

    first_id = next(iter(mapped_features.keys()))
    feature_names = list(mapped_features[first_id].keys())

    if not feature_names:
        return []

    feature_types = {}
    for f in feature_names:
        val = mapped_features[first_id].get(f, False)
        feature_types[f] = "integer" if isinstance(val, (int, float)) and not isinstance(val, bool) else "boolean"

    X = []
    y = []
    ordered_ids = []

    for row_id in common_ids:
        features = mapped_features[row_id]
        score = scores[row_id]

        feature_vector = []
        for f in feature_names:
            val = features.get(f, 0)
            if isinstance(val, bool):
                feature_vector.append(1 if val else 0)
            elif isinstance(val, (int, float)):
                feature_vector.append(int(val))
            else:
                feature_vector.append(0)

        X.append(feature_vector)
        y.append(int(score))
        ordered_ids.append(row_id)

    X = np.array(X)
    y = np.array(y)

    max_depth = min(5, len(feature_names))
    n_unique_scores = len(np.unique(y))

    if n_unique_scores >= 3:
        tree = DecisionTreeClassifier(
            max_depth=max_depth,
            min_samples_leaf=max(2, len(y) // 8),
            class_weight='balanced',
            random_state=42
        )
        tree.fit(X, y)
        use_classifier = True
    else:
        tree = DecisionTreeRegressor(
            max_depth=max_depth,
            min_samples_leaf=max(2, len(y) // 8),
            random_state=42
        )
        tree.fit(X, y)
        use_classifier = False

    _enforce_monotonicity(tree.tree_, feature_names, feature_types,
                          min_score, max_score, use_classifier)

    leaf_indices = tree.apply(X)
    leaf_to_items = {}
    for i, leaf_id in enumerate(leaf_indices):
        leaf_id = int(leaf_id)
        if leaf_id not in leaf_to_items:
            leaf_to_items[leaf_id] = []
        leaf_to_items[leaf_id].append((ordered_ids[i], int(y[i])))

    rules = _extract_rules_from_tree(tree, feature_names, feature_types,
                                     min_score, max_score, use_classifier,
                                     leaf_to_items)

    print(f"Learned {len(rules)} rules from {len(common_ids)} samples")
    for rule in rules:
        print(f"  {rule['raw']}")

    return rules


def _get_leaf_score(tree_, node, min_score, max_score, use_classifier):
    if use_classifier:
        class_counts = tree_.value[node][0]
        score = int(np.argmax(class_counts))
        return int(np.clip(round(tree_.value[node][0] @ np.arange(len(class_counts))
                                 / max(class_counts.sum(), 1)), min_score, max_score))
    else:
        return int(np.clip(round(tree_.value[node][0][0]), min_score, max_score))


def _enforce_monotonicity(tree_, feature_names, feature_types, min_score, max_score, use_classifier):
    def get_subtree_score(node):
        if tree_.feature[node] == -2:
            samples = tree_.n_node_samples[node]
            if use_classifier:
                class_counts = tree_.value[node][0]
                total = class_counts.sum()
                if total == 0:
                    return 0, 0
                avg = sum(i * c for i, c in enumerate(class_counts)) / total
                return avg, samples
            else:
                return tree_.value[node][0][0], samples
        else:
            left_score, left_n = get_subtree_score(tree_.children_left[node])
            right_score, right_n = get_subtree_score(tree_.children_right[node])
            total = left_n + right_n
            if total == 0:
                return 0, 0
            avg = (left_score * left_n + right_score * right_n) / total
            return avg, total

    def set_subtree_score(node, target_score):
        if tree_.feature[node] == -2:
            if use_classifier:
                class_counts = tree_.value[node][0]
                class_counts[:] = 0
                target_idx = int(np.clip(round(target_score), 0, len(class_counts) - 1))
                class_counts[target_idx] = tree_.n_node_samples[node]
            else:
                tree_.value[node][0][0] = target_score
        else:
            set_subtree_score(tree_.children_left[node], target_score)
            set_subtree_score(tree_.children_right[node], target_score)

    violations_fixed = 0

    def fix_node(node):
        nonlocal violations_fixed
        if tree_.feature[node] == -2:
            return

        feat_idx = tree_.feature[node]
        feat = feature_names[feat_idx] if feat_idx < len(feature_names) else "unknown"

        left = tree_.children_left[node]
        right = tree_.children_right[node]

        fix_node(left)
        fix_node(right)

        left_score, left_n = get_subtree_score(left)
        right_score, right_n = get_subtree_score(right)

        if right_score < left_score:
            total = left_n + right_n
            if total > 0:
                avg = (left_score * left_n + right_score * right_n) / total
                avg = np.clip(round(avg), min_score, max_score)
                set_subtree_score(left, avg)
                set_subtree_score(right, avg)
                violations_fixed += 1

    fix_node(0)
    if violations_fixed > 0:
        print(f"  Fixed {violations_fixed} monotonicity violation(s)")


def _extract_rules_from_tree(tree, feature_names, feature_types,
                              min_score, max_score, use_classifier,
                              leaf_to_items=None):
    tree_ = tree.tree_
    classes = tree.classes_ if use_classifier else None

    feature_name = [
        feature_names[i] if i != -2 else "undefined"
        for i in tree_.feature
    ]

    rules = []

    def recurse(node, conditions):
        if tree_.feature[node] == -2:
            if use_classifier:
                class_counts = tree_.value[node][0]
                best_class_idx = int(np.argmax(class_counts))
                score = int(classes[best_class_idx])
            else:
                score = int(np.clip(round(tree_.value[node][0][0]), min_score, max_score))

            score = int(np.clip(score, min_score, max_score))

            node_int = int(node)
            if leaf_to_items and node_int in leaf_to_items:
                items = leaf_to_items[node_int]
                item_ids = [item_id for item_id, _ in items]
                n = len(item_ids)
            else:
                item_ids = []
                n = int(tree_.n_node_samples[node])

            if conditions:
                condition_str = " AND ".join(conditions)
                raw = f"IF {condition_str} THEN Score = {score} (n={n})"
            else:
                raw = f"DEFAULT Score = {score} (n={n})"

            rules.append({
                "conditions": list(conditions) if conditions else ["DEFAULT"],
                "score": score,
                "n": n,
                "item_ids": item_ids,
                "raw": raw
            })
        else:
            feat = feature_name[node]
            threshold = tree_.threshold[node]
            ftype = feature_types.get(feat, "boolean")

            if ftype == "boolean":
                left_conditions = conditions + [f"NOT {feat}"]
                right_conditions = conditions + [feat]
            else:
                left_conditions = conditions + [f"{feat} <= {int(threshold)}"]
                right_conditions = conditions + [f"{feat} > {int(threshold)}"]

            recurse(tree_.children_left[node], left_conditions)
            recurse(tree_.children_right[node], right_conditions)

    recurse(0, [])

    rules.sort(key=lambda r: -r["n"])
    return rules


def simplify_rules(rules, criteria, task, min_score, max_score):
    if not rules:
        return [], 0

    criteria_desc = "\n".join(
        f"- {c['name']} ({c['type']}): {c['definition']}"
        for c in criteria
    ) if criteria else "No criteria available."

    raw_rules_text = "\n".join(r["raw"] for r in rules)

    score_item_ids = {}
    for r in rules:
        s = r["score"]
        if s not in score_item_ids:
            score_item_ids[s] = []
        score_item_ids[s].extend(r.get("item_ids", []))

    prompt = f"""You are simplifying scoring rules for a human reviewer. The rules below were extracted from a decision tree and may be verbose or redundant.

TASK: {task}
Score range: {min_score} to {max_score}

CRITERIA DEFINITIONS:
{criteria_desc}

RAW DECISION TREE RULES:
{raw_rules_text}

Rewrite these rules to be as clear and concise as possible. Requirements:

1. COMBINE: If multiple rules lead to the same score with overlapping conditions, merge them into a single rule.
2. SIMPLIFY: Remove redundant or always-true conditions. Use plain English where it aids clarity.
3. CNF FORM: Express each rule as a conjunction (AND) of simple conditions. Keep conditions atomic.
4. PRESERVE SCORES: Every score value present in the original rules must appear in the output with the same score assignment.
5. PRESERVE COUNTS: Keep the (n=...) counts. When merging rules, sum their counts.
6. ORDER: List rules from highest count (most common) to lowest.
7. NATURAL: Use the criteria names as-is. For boolean criteria, prefer the positive form over the negated form where it reads more naturally — you can invert the phrasing if needed (e.g., "NOT Has Examples" → "Lacks Examples" is fine).
8. CONCISE: Each condition should be short (under 10 words). No explanations or preamble.

Output one rule per line in this exact format:
IF condition1 AND condition2 THEN Score = X (n=Y)
or for a catch-all:
DEFAULT Score = X (n=Y)"""

    simplify_schema = {
        "name": "simplified_rules_response",
        "schema": {
            "type": "object",
            "properties": {
                "rules": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "conditions": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "List of conditions (empty for DEFAULT)"
                            },
                            "score": {
                                "type": "integer",
                                "description": "The score assigned by this rule"
                            },
                            "n": {
                                "type": "integer",
                                "description": "Number of items matching this rule"
                            }
                        },
                        "required": ["conditions", "score", "n"]
                    }
                }
            },
            "required": ["rules"]
        }
    }

    content, _, cost = invoke_llm_with_schema(
        prompt=prompt,
        response_schema=simplify_schema,
        temperature=0.2
    )

    result = json.loads(content)
    simplified = []
    for r in result.get("rules", []):
        conditions = r.get("conditions", [])
        score = int(np.clip(r["score"], min_score, max_score))
        n = r.get("n", 0)

        if not conditions or conditions == [""]:
            raw = f"DEFAULT Score = {score} (n={n})"
            conditions = ["DEFAULT"]
        else:
            condition_str = " AND ".join(conditions)
            raw = f"IF {condition_str} THEN Score = {score} (n={n})"

        item_ids = score_item_ids.get(score, [])

        simplified.append({
            "conditions": conditions,
            "score": score,
            "n": n,
            "item_ids": item_ids,
            "raw": raw
        })

    simplified.sort(key=lambda r: -r["n"])

    print(f"Simplified {len(rules)} raw rules into {len(simplified)} rules")
    for r in simplified:
        print(f"  {r['raw']}")

    return simplified, cost


def compute_feature_importance(tree, feature_names):
    importances = tree.feature_importances_
    return {name: round(float(imp), 4) for name, imp in zip(feature_names, importances)}
