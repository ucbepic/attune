from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pandas import DataFrame
from collections import defaultdict
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

from src.utils.sampling import sample_connected_pairs
from src.consistent_scorer.generate_comparison_prompt import generate_comparison_prompt
from src.consistent_scorer.perform_batched_comparison import perform_batched_comparisons
from src.consistent_scorer.chunked_optimizer import chunked_assign_scores
from src.consistent_scorer.distill_criteria import distill_criteria
from src.utils.client import invoke_llm_with_schema
from src.utils import client as llm_client
from src.consistent_scorer.generalize import map_features
from src.consistent_scorer.characterize import characterize_score_groups

MAX_WORKERS = 8


def generate_rule_summaries(rules, task, min_score, max_score):
    if not rules:
        return {}, {}, 0

    groups = defaultdict(list)
    for r in rules:
        groups[r.get("score", 0)].append(r)

    sorted_scores = sorted(groups.keys())

    group_descriptions = []
    for score in sorted_scores:
        score_rules = groups[score]
        rule_texts = []
        for r in score_rules:
            conditions = r.get("conditions", [])
            n = r.get("n", 0)
            if conditions and conditions[0] in ("DEFAULT", "Other"):
                rule_texts.append(f"  - All other items (n={n})")
            else:
                rule_texts.append(f"  - IF {' AND '.join(conditions)} (n={n})")
        group_descriptions.append(
            f"Score {score} ({len(score_rules)} rule(s), covering items scoring "
            f"{score} on a {min_score}-{max_score} scale):\n" + "\n".join(rule_texts)
        )

    transition_keys = []
    for i in range(len(sorted_scores) - 1):
        transition_keys.append(f"{sorted_scores[i]}->{sorted_scores[i+1]}")

    transition_instruction = ""
    if transition_keys:
        transition_instruction = f"""

Also, for each pair of adjacent score groups, write a very brief transition phrase (max 6-8 words, no full sentence) capturing the key shift. Examples: "adds balanced argumentation", "stronger examples and structure", "loses clarity". Use a transition key like "{transition_keys[0]}" for each."""

    prompt = f"""You are summarizing scoring rules for a scoring task.

Task: {task}
Score range: {min_score} to {max_score}

Below are the decision rules for each score group. For each score, write a concise 1-2 sentence summary that captures what characterizes items in that group. Focus on what makes items in this score group distinctive — don't repeat the score number or say "items scoring X". Write in plain language, not IF/THEN format.

{chr(10).join(group_descriptions)}{transition_instruction}

Return a JSON object with "summaries" (an array of objects, each with a "score" and a "summary") and "transitions" (an array of objects, each with a "key" and a "description")."""

    response_schema = {
        "name": "rule_summaries",
        "schema": {
            "type": "object",
            "properties": {
                "summaries": {
                    "type": "array",
                    "description": "One entry per score group",
                    "items": {
                        "type": "object",
                        "properties": {
                            "score": {"type": "string", "description": "The score number for this group, e.g. \"3\""},
                            "summary": {"type": "string", "description": "1-2 sentence summary of this score group"}
                        },
                        "required": ["score", "summary"]
                    }
                },
                "transitions": {
                    "type": "array",
                    "description": "One entry per pair of adjacent score groups",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string", "description": "Transition key like \"1->2\""},
                            "description": {"type": "string", "description": "Brief transition phrase (max 6-8 words)"}
                        },
                        "required": ["key", "description"]
                    }
                }
            },
            "required": ["summaries", "transitions"],
        }
    }

    try:
        content, _, cost = invoke_llm_with_schema(prompt, response_schema, temperature=0.3)
        result = json.loads(content)
        summaries = {
            str(s["score"]): s.get("summary", "")
            for s in result.get("summaries", [])
            if isinstance(s, dict) and s.get("score") is not None
        }
        transitions = {
            str(t["key"]): t.get("description", "")
            for t in result.get("transitions", [])
            if isinstance(t, dict) and t.get("key")
        }
        return summaries, transitions, cost
    except Exception as e:
        print(f"Error generating rule summaries: {e}")
        return {}, {}, 0


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://attune-frontend.azurewebsites.net",
        "https://attune-alpha.vercel.app",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def apply_llm_config(request: Request, call_next):
    raw_config = request.headers.get("x-llm-config")
    if raw_config:
        try:
            llm_client.configure_llm(json.loads(raw_config))
        except Exception as e:
            print(f"[llm-config] failed to apply request config: {e}")
    return await call_next(request)


@app.get("/")
async def root():
    return {"message": "Awake"}

@app.post("/score")
async def score_endpoint(request_data: dict):
    data = DataFrame(request_data.get("data", []))
    selected_fields = request_data.get("selected_fields", [])
    task = request_data.get("task", "")
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)
    sample_size = request_data.get("sample_size", 30)
    sampled_ids = request_data.get("sampled_ids", [])

    print("Received data")
    print(data.head(), data.shape)

    print("Received Scoring Request")
    print(f"Task: {task}, Min Score: {min_score}, Max Score: {max_score}, Sample Size: {sample_size}, Sampled IDs: {sampled_ids}, Selected Fields: {selected_fields}")


    async def stream_progress():

        total_cost = 0
        consistency = 0
        significant_examples = []
        criteria = []
        rules = []

        try:
            yield f"data: {json.dumps({'progress': 0, 'status': 'Initializing...'})}\n\n"

            loop = asyncio.get_event_loop()

            prompt, cost = await loop.run_in_executor(
                None, lambda: generate_comparison_prompt(task, data[selected_fields].head(5).to_dict(orient="records"))
            )
            total_cost += cost
            print(f"Generated Comparison Prompt: {prompt}")

            sampled_pairs_ids = sample_connected_pairs(sampled_ids, seed=42)
            print(f"Sampled {len(sampled_pairs_ids)} connected pairs for comparison.")
            total_comparisons = len(sampled_pairs_ids)

            comparison_inputs = []
            for a, b in sampled_pairs_ids:
                A = data[data['id'] == a][selected_fields].to_dict(orient="records")[0]
                B = data[data['id'] == b][selected_fields].to_dict(orient="records")[0]
                comparison_inputs.append((a, b, A, B))

            progress_state = {"done": 0}

            def on_progress(done, total):
                progress_state["done"] = done

            comparison_future = loop.run_in_executor(
                None,
                lambda: perform_batched_comparisons(
                    all_pairs=comparison_inputs,
                    comparison_prompt=prompt,
                    task=task,
                    progress_callback=on_progress
                )
            )

            last_reported = 0
            while not comparison_future.done():
                done = progress_state["done"]
                if done > last_reported:
                    pct = int(5 + (done / max(total_comparisons, 1)) * 90)
                    yield f"data: {json.dumps({'progress': pct, 'status': f'Comparing... {done}/{total_comparisons} pairs'})}\n\n"
                    last_reported = done
                await asyncio.sleep(0.3)

            comparison_graph, comparison_cost = await comparison_future
            total_cost += comparison_cost

            yield f"data: {json.dumps({'progress': 96, 'status': f'Comparisons complete ({total_comparisons} pairs)'})}\n\n"
            await asyncio.sleep(0)

            print(comparison_graph)

            yield f"data: {json.dumps({'progress': 96, 'status': 'Scoring...'})}\n\n"
            await asyncio.sleep(0)
            N = sample_size
            pairwise_judgments = [(a, b, choice) for (a, b, choice, _, _, _) in comparison_graph]

            scoring_progress = {"chunks_done": 0, "total_chunks": 1}

            def on_scoring_progress(done, total):
                scoring_progress["chunks_done"] = done
                scoring_progress["total_chunks"] = total

            scoring_future = loop.run_in_executor(
                None,
                lambda: chunked_assign_scores(
                    N, min_score, max_score, pairwise_judgments,
                    time_limit=10, solver_msg=False,
                    progress_callback=on_scoring_progress
                )
            )

            last_chunks_done = 0
            while not scoring_future.done():
                done = scoring_progress["chunks_done"]
                total = scoring_progress["total_chunks"]
                if done > last_chunks_done:
                    pct = 96 + int((done / max(total, 1)) * 1)
                    yield f"data: {json.dumps({'progress': pct, 'status': f'Scoring... chunk {done}/{total}'})}\n\n"
                    last_chunks_done = done
                await asyncio.sleep(0.3)

            solution = await scoring_future

            if solution["status"] not in ("Optimal", "Suboptimal"):
                yield f"data: {json.dumps({'progress': 100, 'status': 'Failed', 'error': 'Could not find optimal scoring solution. Please try reducing the sample size.'})}\n\n"
                return

            scores = solution["assignments"]
            total_edges = len(pairwise_judgments)
            obj_value = solution["consistency"] or 0
            consistency = (total_edges - obj_value) / max(total_edges, 1) * 100
            print(f"Assigned Scores: {scores}")
            print(f"Consistency: {consistency}%")


            yield f"data: {json.dumps({'progress': 98, 'status': 'Discovering Scoring Criteria...'})}\n\n"
            await asyncio.sleep(0)
            criteria, reannotated_comparisons, cost, other_criteria = await loop.run_in_executor(
                None, lambda: distill_criteria(
                    comparison_graph, scores, task,
                    min_score, max_score
                )
            )
            print(f"Distilled Criteria: {criteria}")
            print(f"Other Criteria: {len(other_criteria)} suggestions")
            total_cost += cost

            yield f"data: {json.dumps({'progress': 99, 'status': 'Discovering Scoring Rules...'})}\n\n"
            await asyncio.sleep(0)
            data_slice = data[selected_fields + ['id']][data['id'].isin(sampled_ids)]
            mapped_features, cost = await loop.run_in_executor(
                None, lambda: map_features(criteria, data_slice.to_dict(orient="records"))
            )
            total_cost += cost

            rules, _ = characterize_score_groups(
                scores, mapped_features, criteria, min_score, max_score
            )

            rules_for_client = rules

            rule_summaries, rule_transitions, summary_cost = await loop.run_in_executor(
                None, lambda: generate_rule_summaries(rules, task, min_score, max_score)
            )
            total_cost += summary_cost

            yield f"data: {json.dumps({
                'progress': 100,
                'status': 'Complete',
                'done': True,
                'scores': scores,
                'cost': total_cost,
                'consistency': consistency,
                'significant_examples': significant_examples,
                'criteria': criteria,
                'other_criteria': other_criteria,
                'rules': rules_for_client,
                'rule_summaries': rule_summaries,
                'rule_transitions': rule_transitions,
                'comparison_graph': reannotated_comparisons,
                'mapped_features': mapped_features
            })}\n\n"

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'progress': 100, 'status': 'Failed', 'error': str(e)})}\n\n"
    
    return StreamingResponse(stream_progress(), media_type="text/event-stream")


@app.post("/re-score")
async def re_score_endpoint(request_data: dict):
    comparison_graph = request_data.get("comparison_graph", [])
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)
    sample_size = request_data.get("sample_size", 30)
    examples = request_data.get("examples", {})
    bounds = request_data.get("bounds", {})
    criteria_weights = request_data.get("criteria_weights", {})
    distribution = request_data.get("distribution", None)
    existing_mapped_features = request_data.get("mapped_features", {})
    task = request_data.get("task", "")

    print(f"Re-score request: examples={examples}, bounds={bounds}, criteria_weights={criteria_weights}, distribution={distribution}")

    async def stream_rescore():
        try:
            yield f"data: {json.dumps({'progress': 5, 'status': 'Applying constraints...'})}\n\n"
            await asyncio.sleep(0)

            filtered_graph = []
            edge_weights_list = []

            for edge in comparison_graph:
                a, b, choice = edge[0], edge[1], edge[2]
                confidence = edge[3] if len(edge) > 3 else 0.5
                dist_features = edge[4] if len(edge) > 4 else []
                unif_features = edge[5] if len(edge) > 5 else []

                if isinstance(dist_features, str):
                    dist_features = [dist_features] if dist_features else []
                if isinstance(unif_features, str):
                    unif_features = [unif_features] if unif_features else []

                edge_criteria = dist_features + unif_features

                active_criteria = [c for c in edge_criteria
                                   if not (c in criteria_weights and criteria_weights[c] == 0)]
                if edge_criteria and not active_criteria:
                    continue

                filtered_graph.append([a, b, choice, confidence, dist_features, unif_features])

                if active_criteria:
                    crit_weight = max(criteria_weights.get(c, 2) for c in active_criteria)
                else:
                    crit_weight = 2
                edge_weights_list.append(float(crit_weight))

            if len(filtered_graph) == 0:
                yield f"data: {json.dumps({'progress': 100, 'status': 'Failed', 'error': 'No valid edges after filtering. Re-enable some criteria.'})}\n\n"
                return

            bucket_sizes = None
            if distribution:
                all_ids = set()
                for edge in filtered_graph:
                    all_ids.add(edge[0])
                    all_ids.add(edge[1])
                if examples:
                    for eid in examples:
                        try:
                            all_ids.add(int(eid))
                        except (ValueError, TypeError):
                            all_ids.add(eid)
                N_items = len(all_ids)

                raw_sizes = {}
                for k, v in distribution.items():
                    raw_sizes[int(k)] = float(v) * N_items
                floor_sizes = {k: int(v) for k, v in raw_sizes.items()}
                remainders = {k: raw_sizes[k] - floor_sizes[k] for k in raw_sizes}
                deficit = N_items - sum(floor_sizes.values())
                for k in sorted(remainders, key=remainders.get, reverse=True):
                    if deficit <= 0:
                        break
                    floor_sizes[k] += 1
                    deficit -= 1
                bucket_sizes = floor_sizes
                print(f"Distribution bucket sizes: {bucket_sizes} (N={N_items})")

            examples_dict = None
            if examples and len(examples) > 0:
                examples_dict = {}
                for k, v in examples.items():
                    try:
                        examples_dict[int(k)] = int(v)
                    except (ValueError, TypeError):
                        examples_dict[k] = int(v)
                print(f"Hard example constraints: {examples_dict}")

            bounds_dict = None
            if bounds and len(bounds) > 0:
                bounds_dict = {}
                for k, v in bounds.items():
                    try:
                        key = int(k)
                    except (ValueError, TypeError):
                        key = k
                    bound = {}
                    if "min" in v:
                        bound["min"] = int(v["min"])
                    if "max" in v:
                        bound["max"] = int(v["max"])
                    if bound:
                        bounds_dict[key] = bound
                print(f"Bound constraints: {bounds_dict}")

            yield f"data: {json.dumps({'progress': 30, 'status': 'Running optimization...'})}\n\n"
            await asyncio.sleep(0)

            pairwise_judgments = [(e[0], e[1], e[2]) for e in filtered_graph]
            dist_weight = None
            if bucket_sizes:
                avg_edge_weight = sum(edge_weights_list) / max(len(edge_weights_list), 1)
                dist_weight = avg_edge_weight * len(filtered_graph) * 0.5

            loop = asyncio.get_event_loop()
            solution = await loop.run_in_executor(
                None,
                lambda: chunked_assign_scores(
                    sample_size, min_score, max_score, pairwise_judgments,
                    examples=examples_dict,
                    bounds=bounds_dict,
                    bucket_sizes=bucket_sizes,
                    edge_weights=edge_weights_list,
                    distribution_weight=dist_weight,
                    time_limit=30,
                    solver_msg=False
                )
            )

            if not solution or solution["status"] not in ("Optimal", "Suboptimal"):
                yield f"data: {json.dumps({'progress': 100, 'status': 'Failed', 'error': 'Could not find optimal solution. Try relaxing constraints.'})}\n\n"
                return

            scores = solution["assignments"]
            total_edges = len(filtered_graph)
            obj_value = solution["consistency"] or 0
            consistency = (total_edges - obj_value) / max(total_edges, 1) * 100

            rules = []
            if existing_mapped_features and len(existing_mapped_features) > 0:
                mf = {}
                for k, v in existing_mapped_features.items():
                    try:
                        mf[int(k)] = v
                    except (ValueError, TypeError):
                        mf[k] = v
                criteria_list = request_data.get("criteria", [])
                rules, _ = characterize_score_groups(
                    scores, mf, criteria_list, min_score, max_score
                )

            loop = asyncio.get_event_loop()
            rule_summaries, rule_transitions, summary_cost = await loop.run_in_executor(
                None, lambda: generate_rule_summaries(rules, task, min_score, max_score)
            )

            yield f"data: {json.dumps({
                'progress': 100,
                'status': 'Complete',
                'done': True,
                'scores': {str(k): v for k, v in scores.items()},
                'cost': summary_cost,
                'consistency': consistency,
                'rules': rules,
                'rule_summaries': rule_summaries,
                'rule_transitions': rule_transitions,
            })}\n\n"

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'progress': 100, 'status': 'Failed', 'error': str(e)})}\n\n"

    return StreamingResponse(stream_rescore(), media_type="text/event-stream")


@app.post("/recharacterize")
async def recharacterize_endpoint(request_data: dict):
    scores = request_data.get("scores", {})
    mapped_features = request_data.get("mapped_features", {})
    criteria = request_data.get("criteria", [])
    task = request_data.get("task", "")
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)

    norm_scores = {}
    for k, v in scores.items():
        try:
            norm_scores[int(k)] = int(v)
        except (ValueError, TypeError):
            norm_scores[k] = int(v)

    norm_mf = {}
    for k, v in mapped_features.items():
        try:
            norm_mf[int(k)] = v
        except (ValueError, TypeError):
            norm_mf[k] = v

    rules, _ = characterize_score_groups(norm_scores, norm_mf, criteria, min_score, max_score)

    loop = asyncio.get_event_loop()
    rule_summaries, rule_transitions, summary_cost = await loop.run_in_executor(
        None, lambda: generate_rule_summaries(rules, task, min_score, max_score)
    )

    return {
        "rules": rules,
        "rule_summaries": rule_summaries,
        "rule_transitions": rule_transitions,
        "cost": summary_cost,
    }


@app.post("/summarize-rules")
async def summarize_rules_endpoint(request_data: dict):
    task = request_data.get("task", "")
    rules = request_data.get("rules", [])
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)

    try:
        loop = asyncio.get_event_loop()
        summaries, transitions, cost = await loop.run_in_executor(
            None, lambda: generate_rule_summaries(rules, task, min_score, max_score)
        )
        return {"summaries": summaries, "transitions": transitions, "cost": cost}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"summaries": {}, "transitions": {}, "cost": 0, "error": str(e)}


@app.post("/interpret-feedback")
async def interpret_feedback_endpoint(request_data: dict):
    message = request_data.get("message", "")
    task = request_data.get("task", "")
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)
    criteria = request_data.get("criteria", [])
    selected_items = request_data.get("selected_items", [])
    data_summary = request_data.get("data_summary", "")

    criteria_text = "\n".join(
        f"- {c['name']} ({c.get('type','')}) : {c.get('definition','')}"
        for c in criteria
    ) if criteria else "No criteria defined yet."

    items_text = ""
    if selected_items:
        parts = []
        for item in selected_items:
            fields_str = ", ".join(f"{k}: {v}" for k, v in item.items())
            parts.append(f"  [{fields_str}]")
        items_text = "\n".join(parts)
    else:
        items_text = "No items selected."

    summary_section = f"\nDataset summary: {data_summary}" if data_summary else ""

    prompt = f"""You are an assistant that interprets user feedback about a scoring system and produces a concrete plan of actions.

Scoring task: {task}
Score range: {min_score} to {max_score}

Current criteria (already being tracked):
{criteria_text}
{summary_section}

Selected items (user highlighted these):
{items_text}

User says:
"{message}"

IMPORTANT RULES:

1. @ MENTIONS: When the user writes @CriterionName, they are referencing a specific existing criterion by name. Match it to the closest criterion in the list above. Do NOT create a new criterion if the @ mention matches an existing one.

2. move_to_score: USE THIS when the user says items matching a criterion condition should BE a specific score (e.g. "if @X >= 5 then score should be 12", "items with @Y should be score 3"). This directly moves matching items to the target score without re-running optimization. The criteria_filter specifies which items to match (criterion name, operator like >=, <=, ==, >, <, and value for integer criteria, or match=true/false for boolean criteria). The target_score is the exact score to assign.

3. pin_examples: Use when user says specific selected items should be an exact score (e.g. "these should be score 3"). Only for specific items the user pointed to.

4. set_bounds: Use ONLY when the user wants to constrain items to a score RANGE (min/max), not an exact score. Use criteria_filter for filtering by criterion, or bounds array for specific IDs.

5. set_distribution: Use when user wants to change the overall shape of scores (e.g. "bell curve", "spread evenly"). Template must be one of: uniform, gaussian, left-skew, right-skew.

6. add_criteria: Use ONLY when the user references a concept that does NOT exist as a criterion yet. Do NOT add criteria that already exist.

7. CRITERIA GAP CHECK: If the user's feedback references a concept not captured by existing criteria AND not prefixed with @, you MUST emit an add_criteria action FIRST, then a move_to_score or set_bounds referencing it.

8. ORDERING: Always emit add_criteria actions BEFORE move_to_score or set_bounds actions that depend on them.

9. PREFER move_to_score OVER set_bounds when the user specifies an exact target score for items matching a criterion condition (e.g. "if X >= 5, score should be 12" → move_to_score, NOT set_bounds).

10. EXPLANATION STYLE: Write explanations as short, plain-language descriptions of what the system will do. Address the user directly. Do not mention optimization, constraints, bounds, or internal terminology.

11. REASONING: Write 1-2 sentences describing what you'll do. Do NOT describe what you won't do. Do NOT mention action type names or internal terms."""

    response_schema = {
        "name": "interpret_feedback_response",
        "schema": {
            "type": "object",
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "1-2 sentence plain-language summary of what will be done, addressed to the user"
                },
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "description": "Action type: pin_examples, move_to_score, set_bounds, set_distribution, or add_criteria"
                            },
                            "explanation": {
                                "type": "string",
                                "description": "Plain-language description of this step, no internal terminology"
                            },
                            "items": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "string"},
                                        "score": {"type": "integer"}
                                    },
                                    "required": ["id", "score"]
                                },
                                "description": "Items with pinned scores (for pin_examples)"
                            },
                            "bounds": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "string"},
                                        "min": {"type": ["integer", "null"]},
                                        "max": {"type": ["integer", "null"]}
                                    },
                                    "required": ["id"]
                                },
                                "description": "Specific item IDs with score limits (for set_bounds with known IDs)"
                            },
                            "criteria_filter": {
                                "type": "object",
                                "properties": {
                                    "criterion": {
                                        "type": "string",
                                        "description": "Name of the criterion to filter by (must match a criterion name from add_criteria or existing criteria)"
                                    },
                                    "match": {
                                        "type": "boolean",
                                        "description": "For boolean criteria: true = items where criterion is true. For integer criteria with operator: ignored (use operator/value instead)."
                                    },
                                    "operator": {
                                        "type": "string",
                                        "description": "Comparison operator for integer criteria: >=, <=, ==, >, <. Omit for boolean criteria."
                                    },
                                    "value": {
                                        "type": ["integer", "null"],
                                        "description": "Threshold value for integer criteria comparison. Omit for boolean criteria."
                                    },
                                    "min": {"type": ["integer", "null"]},
                                    "max": {"type": ["integer", "null"]}
                                },
                                "required": ["criterion"],
                                "description": "Filter items by criterion value. For move_to_score: use criterion + operator + value (integer) or criterion + match (boolean). For set_bounds: also include min/max score limits."
                            },
                            "target_score": {
                                "type": "integer",
                                "description": "The exact score to assign to matching items (for move_to_score only)"
                            },
                            "template": {
                                "type": "string",
                                "description": "Distribution template: uniform, gaussian, left-skew, or right-skew (for set_distribution)"
                            },
                            "criteria": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "type": {"type": "string"},
                                        "definition": {"type": "string"}
                                    },
                                    "required": ["name", "type", "definition"]
                                },
                                "description": "New criteria to add (for add_criteria)"
                            }
                        },
                        "required": ["type", "explanation"]
                    },
                    "description": "Ordered list of actions — add_criteria must come before set_bounds that depend on them"
                }
            },
            "required": ["reasoning", "actions"]
        }
    }

    try:
        loop = asyncio.get_event_loop()
        content, _, cost = await loop.run_in_executor(
            None,
            lambda: invoke_llm_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                temperature=0.3
            )
        )
        result = json.loads(content)
        return {
            "actions": result.get("actions", []),
            "reasoning": result.get("reasoning", ""),
            "cost": cost
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"actions": [], "reasoning": f"Error: {str(e)}", "cost": 0}


@app.post("/add-criteria")
async def add_criteria_endpoint(request_data: dict):
    criteria = request_data.get("criteria", [])
    data = request_data.get("data", [])
    selected_fields = request_data.get("selected_fields", [])

    data_slice = []
    for item in data:
        filtered_item = {"id": item.get("id")}
        for field in selected_fields:
            if field in item:
                filtered_item[field] = item[field]
        data_slice.append(filtered_item)

    try:
        loop = asyncio.get_event_loop()
        mapped_features, cost = await loop.run_in_executor(
            None,
            lambda: map_features(criteria, data_slice)
        )
        return {
            "mapped_features": mapped_features,
            "cost": cost,
            "criteria": criteria
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"mapped_features": {}, "cost": 0, "criteria": criteria, "error": str(e)}


@app.post("/baseline-score")
async def baseline_score_endpoint(request_data: dict):
    data = DataFrame(request_data.get("data", []))
    selected_fields = request_data.get("selected_fields", [])
    task = request_data.get("task", "")
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)

    BATCH_SIZE = 20

    print("Baseline scoring request")
    print(f"Task: {task}, Min: {min_score}, Max: {max_score}, Total items: {len(data)}")

    async def stream_baseline():
        total_cost = 0
        scores = {}

        yield f"data: {json.dumps({'progress': 0, 'status': 'Initializing...'})}\n\n"

        total_items = len(data)
        batches = [data.iloc[i:i + BATCH_SIZE] for i in range(0, total_items, BATCH_SIZE)]
        total_batches = len(batches)
        batches_done = 0

        def score_batch(batch_df):
            items_text_parts = []
            batch_ids = []
            for idx, (_, row) in enumerate(batch_df.iterrows()):
                batch_ids.append(row['id'])
                item_fields = "\n".join(f"  {field}: {row[field]}" for field in selected_fields if field in row)
                items_text_parts.append(f"Item {idx + 1} (id: {row['id']}):\n{item_fields}")

            items_text = "\n\n".join(items_text_parts)

            prompt = f"""You are a scoring assistant. Score each of the following items based on the task description.

Task: {task}

Score range: {min_score} (lowest) to {max_score} (highest)

Items to score:
{items_text}

For each item, provide a score as an integer between {min_score} and {max_score} inclusive, along with brief reasoning.
Respond in JSON format with a "scores" array containing one object per item, in the same order as presented."""

            batch_schema = {
                "name": "batch_score_response",
                "schema": {
                    "type": "object",
                    "properties": {
                        "scores": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {
                                        "type": "string",
                                        "description": "The id of the item"
                                    },
                                    "score": {
                                        "type": "integer",
                                        "description": f"Score between {min_score} and {max_score}"
                                    },
                                    "reasoning": {
                                        "type": "string",
                                        "description": "Brief reasoning for the score"
                                    }
                                },
                                "required": ["id", "score", "reasoning"]
                            },
                            "description": "Array of score objects, one per item"
                        }
                    },
                    "required": ["scores"]
                }
            }

            try:
                content, _, cost = invoke_llm_with_schema(
                    prompt=prompt,
                    response_schema=batch_schema,
                    temperature=0.0
                )
                result = json.loads(content)
                batch_scores = {}
                for item_score in result["scores"]:
                    item_id = item_score["id"]
                    score = max(min_score, min(max_score, item_score["score"]))
                    batch_scores[item_id] = score
                if len(batch_scores) < len(batch_ids):
                    for i, sid in enumerate(batch_ids):
                        if str(sid) not in batch_scores and sid not in batch_scores and i < len(result["scores"]):
                            score = max(min_score, min(max_score, result["scores"][i]["score"]))
                            batch_scores[sid] = score
                return batch_scores, cost
            except Exception as e:
                print(f"Error scoring batch: {e}")
                return {}, 0

        yield f"data: {json.dumps({'progress': 5, 'status': f'Scoring {total_items} items...'})}\n\n"
        await asyncio.sleep(0)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(score_batch, batch): i for i, batch in enumerate(batches)}

            for future in as_completed(futures):
                batch_scores, batch_cost = future.result()
                scores.update(batch_scores)
                total_cost += batch_cost
                batches_done += 1
                items_scored_so_far = min(batches_done * BATCH_SIZE, total_items)
                progress = int((batches_done / total_batches) * 95) + 5
                yield f"data: {json.dumps({'progress': progress, 'status': f'Scoring... {items_scored_so_far}/{total_items} items'})}\n\n"
                await asyncio.sleep(0)

        print(f"Baseline scored {len(scores)} items in {total_batches} batches. Cost: ${total_cost:.4f}")

        result_payload = json.dumps({
            'progress': 100,
            'status': 'Complete',
            'done': True,
            'scores': {str(k): v for k, v in scores.items()},
            'cost': total_cost,
            'consistency': 0,
            'criteria': [],
            'rules': '',
            'mapped_features': {}
        })
        yield f"data: {result_payload}\n\n"

    return StreamingResponse(stream_baseline(), media_type="text/event-stream")


@app.post("/chat-refine")
async def chat_refine_endpoint(request_data: dict):
    message = request_data.get("message", "")
    current_prompt = request_data.get("current_prompt", "")
    refinement_history = request_data.get("refinement_history", [])
    task = request_data.get("task", "")
    min_score = request_data.get("min_score", 1)
    max_score = request_data.get("max_score", 10)
    selected_fields = request_data.get("selected_fields", [])
    data_raw = request_data.get("data", [])
    sampled_ids = request_data.get("sampled_ids", [])
    context_ids = request_data.get("context_ids", [])

    data = DataFrame(data_raw)

    context_items_text = ""
    if context_ids and len(context_ids) > 0:
        context_rows = data[data['id'].isin(context_ids)]
        if len(context_rows) > 0:
            parts = []
            for _, row in context_rows.iterrows():
                fields_str = "\n".join(f"  {field}: {row[field]}" for field in selected_fields if field in row)
                score_str = f" (current score: {row['score']})" if 'score' in row and row.get('score') is not None else ""
                parts.append(f"Item (id: {row['id']}){score_str}:\n{fields_str}")
            context_items_text = "\n\n".join(parts)

    print(f"Chat refinement request: {message}")
    print(f"Current prompt: {current_prompt}")
    print(f"Refinement history: {refinement_history}")
    print(f"Context IDs: {context_ids}")

    async def stream_refinement():
        total_cost = 0

        yield f"data: {json.dumps({'status': 'Interpreting your refinement...'})}\n\n"
        await asyncio.sleep(0)

        context_section = ""
        if context_items_text:
            context_section = f"""\n\nThe user has selected the following specific items as context for their refinement. Use these concrete examples to understand exactly what the user means and incorporate data-specific guidance (e.g. example-based rules, score anchors) into the updated prompt where appropriate:

{context_items_text}\n"""

        prompt_update_instruction = f"""You are a scoring task prompt engineer. The user has a scoring task and wants to refine how items are scored.

Current scoring task description:
{current_prompt}

Score range: {min_score} to {max_score}

Previous refinements applied:
{chr(10).join(f"- {r}" for r in refinement_history) if refinement_history else "None yet."}
{context_section}
The user's new refinement request:
"{message}"

Based on this refinement request, produce an updated scoring task description that incorporates the user's feedback. The updated description should be a complete, self-contained task description (not just the delta). Keep it clear and specific. If the user referenced specific items above, use them as concrete examples or anchors in the updated prompt to make the scoring criteria more precise.

Also produce a brief explanation of what changed and why, to show the user.

Respond in JSON format."""

        prompt_schema = {
            "name": "prompt_update",
            "schema": {
                "type": "object",
                "properties": {
                    "updated_prompt": {
                        "type": "string",
                        "description": "The complete updated scoring task description incorporating the refinement"
                    },
                    "explanation": {
                        "type": "string",
                        "description": "Brief explanation of what was refined and why"
                    }
                },
                "required": ["updated_prompt", "explanation"]
            }
        }

        try:
            content, _, cost = invoke_llm_with_schema(
                prompt=prompt_update_instruction,
                response_schema=prompt_schema,
                temperature=0.3
            )
            total_cost += cost
            result = json.loads(content)
            updated_prompt = result["updated_prompt"]
            explanation = result["explanation"]
        except Exception as e:
            print(f"Error updating prompt: {e}")
            yield f"data: {json.dumps({'done': True, 'response': f'Error interpreting refinement: {str(e)}'})}\n\n"
            return

        print(f"Updated prompt: {updated_prompt}")
        print(f"Explanation: {explanation}")

        yield f"data: {json.dumps({'status': 'Re-scoring items with updated criteria...'})}\n\n"
        await asyncio.sleep(0)

        if not sampled_ids or len(sampled_ids) == 0:
            yield f"data: {json.dumps({
                'done': True,
                'response': f'{explanation}\\n\\nPrompt updated but no items to re-score. Run initial scoring first.',
                'updated_prompt': updated_prompt,
                'cost': total_cost
            })}\n\n"
            return

        BATCH_SIZE = 20
        scores = {}
        scoring_prompt_template = f"""You are a scoring assistant. Score each of the following items based on the task description.

Task: {updated_prompt}

Score range: {min_score} (lowest) to {max_score} (highest)

Items to score:
{{items_text}}

For each item, provide a score as an integer between {min_score} and {max_score} inclusive, along with brief reasoning.
Respond in JSON format with a "scores" array containing one object per item, in the same order as presented."""

        batch_schema = {
            "name": "batch_score_response",
            "schema": {
                "type": "object",
                "properties": {
                    "scores": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "The id of the item"
                                },
                                "score": {
                                    "type": "integer",
                                    "description": f"Score between {min_score} and {max_score}"
                                },
                                "reasoning": {
                                    "type": "string",
                                    "description": "Brief reasoning for the score"
                                }
                            },
                            "required": ["id", "score", "reasoning"]
                        },
                        "description": "Array of score objects, one per item"
                    }
                },
                "required": ["scores"]
            }
        }

        items_to_score = data[data['id'].isin(sampled_ids)]
        total_items = len(items_to_score)

        batches = [items_to_score.iloc[i:i + BATCH_SIZE] for i in range(0, total_items, BATCH_SIZE)]
        total_batches = len(batches)
        batches_done = 0

        def score_batch(batch_df):
            items_text_parts = []
            batch_ids = []
            for idx, (_, row) in enumerate(batch_df.iterrows()):
                batch_ids.append(row['id'])
                item_fields = "\n".join(f"  {field}: {row[field]}" for field in selected_fields if field in row)
                items_text_parts.append(f"Item {idx + 1} (id: {row['id']}):\n{item_fields}")

            items_text = "\n\n".join(items_text_parts)
            prompt = scoring_prompt_template.replace("{items_text}", items_text)

            try:
                content, _, cost = invoke_llm_with_schema(
                    prompt=prompt,
                    response_schema=batch_schema,
                    temperature=0.0
                )
                result = json.loads(content)
                batch_scores = {}
                for item_score in result["scores"]:
                    item_id = item_score["id"]
                    score = max(min_score, min(max_score, item_score["score"]))
                    batch_scores[item_id] = score
                if len(batch_scores) < len(batch_ids):
                    for i, sid in enumerate(batch_ids):
                        if str(sid) not in batch_scores and sid not in batch_scores and i < len(result["scores"]):
                            score = max(min_score, min(max_score, result["scores"][i]["score"]))
                            batch_scores[sid] = score
                return batch_scores, cost
            except Exception as e:
                print(f"Error scoring batch: {e}")
                return {}, 0

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(score_batch, batch): i for i, batch in enumerate(batches)}

            for future in as_completed(futures):
                batch_scores, batch_cost = future.result()
                scores.update(batch_scores)
                total_cost += batch_cost
                batches_done += 1
                items_scored_so_far = min(batches_done * BATCH_SIZE, total_items)
                yield f"data: {json.dumps({'status': f'Re-scoring... {items_scored_so_far}/{total_items}'})}\n\n"
                await asyncio.sleep(0)

        print(f"Re-scored {len(scores)} items. Total cost: ${total_cost:.4f}")

        response_text = f"{explanation}\n\nRe-scored {len(scores)} items with the updated criteria."

        yield f"data: {json.dumps({
            'done': True,
            'response': response_text,
            'updated_prompt': updated_prompt,
            'scores': {str(k): v for k, v in scores.items()},
            'cost': total_cost
        })}\n\n"

    return StreamingResponse(stream_refinement(), media_type="text/event-stream")