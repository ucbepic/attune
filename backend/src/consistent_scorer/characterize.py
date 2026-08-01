from collections import defaultdict

MAX_RULES_PER_GROUP = 3
MAX_CONDITIONS_PER_RULE = 2
MIN_COVERAGE_THRESH = 0.45
MIN_LIFT = 1.3


def characterize_score_groups(scores, mapped_features, criteria, min_score, max_score):
    if not scores or not mapped_features:
        return [], 0

    common_ids = sorted(set(scores.keys()) & set(mapped_features.keys()))
    if not common_ids:
        return [], 0

    feature_meta = _build_feature_meta(criteria, mapped_features, common_ids)
    if not feature_meta:
        return [], 0

    groups: dict[int, list] = defaultdict(list)
    for rid in common_ids:
        groups[int(scores[rid])].append(rid)

    sorted_scores = sorted(groups.keys())

    all_rules = []
    for score_val in sorted_scores:
        group_ids = groups[score_val]
        other_ids = [rid for rid in common_ids if int(scores[rid]) != score_val]
        group_rules = _characterize_group(
            score_val, group_ids, other_ids,
            mapped_features, feature_meta,
        )
        all_rules.extend(group_rules)

    all_rules.sort(key=lambda r: (r["score"], -r["n"]))

    print(f"Characterized {len(sorted_scores)} score groups → {len(all_rules)} rules")
    for r in all_rules:
        print(f"  {r['raw']}")

    return all_rules, 0

def _build_feature_meta(criteria, mapped_features, common_ids):
    meta = []

    criteria_map = {}
    if criteria:
        for c in criteria:
            name = c.get("name") or c.get("text")
            if name:
                criteria_map[name] = c.get("type", "boolean")

    first = mapped_features[common_ids[0]]
    for fname in first:
        if fname in criteria_map:
            ftype = criteria_map[fname]
        else:
            val = first[fname]
            if isinstance(val, bool):
                ftype = "boolean"
            elif isinstance(val, (int, float)):
                ftype = "integer"
            else:
                ftype = "boolean"
        meta.append({"name": fname, "type": ftype})

    return meta


def _feature_value(mapped_features, rid, fname, ftype):
    val = mapped_features[rid].get(fname)
    if ftype == "boolean":
        if isinstance(val, bool):
            return val
        return bool(val)
    else:
        try:
            return int(val)
        except (TypeError, ValueError):
            return 0


def _compute_discriminators(group_ids, other_ids, mapped_features, feature_meta):
    candidates = []

    n_group = len(group_ids)
    n_other = len(other_ids)
    if n_group == 0:
        return candidates

    for fm in feature_meta:
        fname = fm["name"]
        ftype = fm["type"]

        if ftype == "boolean":
            g_true_ids = [rid for rid in group_ids
                          if _feature_value(mapped_features, rid, fname, ftype)]
            o_true = sum(1 for rid in other_ids
                         if _feature_value(mapped_features, rid, fname, ftype))

            p_g = len(g_true_ids) / n_group if n_group else 0
            p_o = o_true / n_other if n_other else 0

            if p_g > p_o and p_g >= 0.3:
                lift = p_g / max(p_o, 1e-6)
                if lift >= MIN_LIFT:
                    candidates.append((fname, set(g_true_ids), lift))

            g_false_ids = [rid for rid in group_ids
                           if not _feature_value(mapped_features, rid, fname, ftype)]
            p_g_neg = len(g_false_ids) / n_group if n_group else 0
            p_o_neg = (n_other - o_true) / n_other if n_other else 0

            if p_g_neg > p_o_neg and p_g_neg >= 0.3:
                lift = p_g_neg / max(p_o_neg, 1e-6)
                if lift >= MIN_LIFT:
                    candidates.append((f"NOT {fname}", set(g_false_ids), lift))

        else:
            g_vals = [(rid, _feature_value(mapped_features, rid, fname, ftype))
                      for rid in group_ids]
            o_vals = [_feature_value(mapped_features, rid, fname, ftype)
                      for rid in other_ids]

            if not g_vals or not o_vals:
                continue

            all_vals = sorted(set(v for _, v in g_vals) | set(o_vals))

            best_cond = None
            best_ids = set()
            best_lift = 0

            for thresh in all_vals:
                for op, op_str, test_fn in [
                    ("gt", f"{fname} > {thresh}", lambda v, t=thresh: v > t),
                    ("le", f"{fname} <= {thresh}", lambda v, t=thresh: v <= t),
                ]:
                    g_match = [rid for rid, v in g_vals if test_fn(v)]
                    o_match = sum(1 for v in o_vals if test_fn(v))

                    p_g = len(g_match) / n_group
                    p_o = o_match / n_other if n_other else 0

                    if p_g > p_o and p_g >= 0.3:
                        lift = p_g / max(p_o, 1e-6)
                        if lift > best_lift:
                            best_lift = lift
                            best_cond = op_str
                            best_ids = set(g_match)

            if best_cond and best_lift >= MIN_LIFT:
                candidates.append((best_cond, best_ids, best_lift))

    candidates.sort(key=lambda c: -c[2])
    return candidates


def _build_one_conjunction(group_ids, other_ids, mapped_features, feature_meta):
    n_total = len(group_ids)
    if n_total == 0:
        return [], set()

    candidates = _compute_discriminators(
        group_ids, other_ids, mapped_features, feature_meta
    )

    if not candidates:
        return [], set()

    selected_conditions = []
    current_match = set(group_ids)

    for cond_str, cond_match_ids, lift in candidates:
        if not current_match:
            break

        new_match = current_match & cond_match_ids

        if len(new_match) < max(1, n_total * MIN_COVERAGE_THRESH):
            continue

        if len(cond_match_ids) >= len(group_ids) + len(other_ids):
            continue

        selected_conditions.append(cond_str)
        current_match = new_match

        if len(selected_conditions) >= MAX_CONDITIONS_PER_RULE:
            break

    return selected_conditions, current_match


def _characterize_group(score_val, group_ids, other_ids,
                         mapped_features, feature_meta):
    n_total = len(group_ids)
    rules = []
    remaining = set(group_ids)

    for _ in range(MAX_RULES_PER_GROUP):
        if not remaining:
            break

        remaining_list = sorted(remaining)
        conditions, matched = _build_one_conjunction(
            remaining_list, other_ids, mapped_features, feature_meta
        )

        if not conditions or not matched:
            break

        matched = matched & remaining
        if not matched:
            break

        n_matched = len(matched)
        condition_str = " AND ".join(conditions)
        raw = f"IF {condition_str} THEN Score = {score_val} (n={n_matched}/{n_total})"

        rules.append({
            "conditions": conditions,
            "score": score_val,
            "n": n_matched,
            "n_total": n_total,
            "item_ids": sorted(matched, key=lambda x: (isinstance(x, str), x)),
            "raw": raw,
        })

        remaining -= matched

    if remaining:
        rules.append({
            "conditions": ["Other"],
            "score": score_val,
            "n": len(remaining),
            "n_total": n_total,
            "item_ids": sorted(remaining, key=lambda x: (isinstance(x, str), x)),
            "raw": f"Other → Score = {score_val} (n={len(remaining)}/{n_total})",
        })

    if not rules:
        rules.append({
            "conditions": ["DEFAULT"],
            "score": score_val,
            "n": n_total,
            "n_total": n_total,
            "item_ids": sorted(group_ids, key=lambda x: (isinstance(x, str), x)),
            "raw": f"DEFAULT Score = {score_val} (n={n_total})",
        })

    return rules
