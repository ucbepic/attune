import pulp

def assign_scores(_N, min_score, max_score, pairwise_judgments, examples=None, bounds=None, bucket_sizes=None, weights=None, edge_weights=None, distribution_weight=None, time_limit=None, solver_msg=False):

    if weights is None:
        weights = {
            "A": 1.0,
            "B": 1.0,
            "=": 2.0,
        }

    K = max_score - min_score + 1
    M = K

    example_ids = set()
    for a, b, _ in pairwise_judgments:
        example_ids.add(a)
        example_ids.add(b)

    if examples is not None:
        example_ids.update(examples.keys())

    if bounds is not None:
        example_ids.update(bounds.keys())

    example_ids = sorted(example_ids)

    model = pulp.LpProblem("ConsistentScoring", pulp.LpMinimize)

    s = {
        i: pulp.LpVariable(f"s_{i}", lowBound=min_score, upBound=max_score, cat="Integer")
        for i in example_ids
    }

    v = {
        idx: pulp.LpVariable(f"v_{idx}", cat="Binary")
        for idx in range(len(pairwise_judgments))
    }

    if examples is not None:
        for i, b in examples.items():
            model += s[i] == b

    if bounds is not None:
        for i, bound in bounds.items():
            if "min" in bound:
                s[i].lowBound = max(min_score, int(bound["min"]))
            if "max" in bound:
                s[i].upBound = min(max_score, int(bound["max"]))

    x = {}
    dist_slack_vars = []
    if bucket_sizes is not None:
        for i in example_ids:
            for b in range(min_score, max_score + 1):
                x[i, b] = pulp.LpVariable(f"x_{i}_{b}", cat="Binary")

            model += pulp.lpSum(x[i, b] for b in range(min_score, max_score + 1)) == 1
            model += s[i] == pulp.lpSum(b * x[i, b] for b in range(min_score, max_score + 1))

        if distribution_weight is not None and distribution_weight > 0:
            for b, size in bucket_sizes.items():
                over = pulp.LpVariable(f"over_{b}", lowBound=0, cat="Integer")
                under = pulp.LpVariable(f"under_{b}", lowBound=0, cat="Integer")
                actual_count = pulp.lpSum(x[i, b] for i in example_ids)
                model += actual_count - over + under == size
                dist_slack_vars.append((over, under))
        else:
            for b, size in bucket_sizes.items():
                model += pulp.lpSum(x[i, b] for i in example_ids) == size

    for idx, (a, b, judgment) in enumerate(pairwise_judgments):
        if judgment == "A":
            model += s[a] - s[b] >= 1 - M * v[idx]
        elif judgment == "B":
            model += s[b] - s[a] >= 1 - M * v[idx]
        elif judgment == "=":
            model += s[a] - s[b] <= M * v[idx]
            model += s[b] - s[a] <= M * v[idx]

    pairwise_cost = pulp.lpSum(
        (edge_weights[idx] if edge_weights else 1.0) * weights[judgment] * v[idx]
        for idx, (_, _, judgment) in enumerate(pairwise_judgments)
    )

    if dist_slack_vars and distribution_weight:
        dist_cost = distribution_weight * pulp.lpSum(
            over + under for over, under in dist_slack_vars
        )
        model += pairwise_cost + dist_cost
    else:
        model += pairwise_cost

    solver = pulp.PULP_CBC_CMD(msg=solver_msg, timeLimit=time_limit)
    status = model.solve(solver)

    assignments = {}
    for i in example_ids:
        val = pulp.value(s[i])
        if val is not None:
            assignments[i] = int(round(val))

    obj_value = pulp.value(model.objective)

    return {
        "status": pulp.LpStatus[status],
        "assignments": assignments,
        "consistency": obj_value if obj_value is not None else 0
    }
