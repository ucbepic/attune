import math
import random
from collections import defaultdict

from .constraint_optimizer import assign_scores

TARGET_CHUNK_SIZE = 30
MIN_OVERLAP = 3
CHUNK_THRESHOLD = 40


def _build_adjacency(pairwise_judgments):
    adj = defaultdict(list)
    for idx, (a, b, _) in enumerate(pairwise_judgments):
        adj[a].append((b, idx))
        adj[b].append((a, idx))
    return adj


def _partition_graph(all_ids, adj, pairwise_judgments, target_size=TARGET_CHUNK_SIZE, min_overlap=MIN_OVERLAP):
    all_ids_set = set(all_ids)
    assigned = set()
    chunks = []

    remaining = set(all_ids)

    while remaining:
        seed = next(iter(remaining))

        chunk_items = set()
        queue = [seed]
        visited = {seed}

        while queue and len(chunk_items) < target_size:
            node = queue.pop(0)
            chunk_items.add(node)

            for neighbor, _ in adj.get(node, []):
                if neighbor not in visited and len(chunk_items) < target_size + min_overlap:
                    visited.add(neighbor)
                    queue.append(neighbor)

        if len(chunk_items) < target_size // 3 and chunks:
            prev_items, prev_edges = chunks[-1]
            chunk_items = prev_items | chunk_items
            chunks.pop()

        chunk_edge_indices = []
        for idx, (a, b, _) in enumerate(pairwise_judgments):
            if a in chunk_items and b in chunk_items:
                chunk_edge_indices.append(idx)

        chunks.append((chunk_items, chunk_edge_indices))
        remaining -= chunk_items

    if len(chunks) > 1:
        chunks = _add_overlaps(chunks, adj, pairwise_judgments, min_overlap)

    return chunks


def _add_overlaps(chunks, adj, pairwise_judgments, min_overlap):
    for i in range(len(chunks) - 1):
        items_a, edges_a = chunks[i]
        items_b, edges_b = chunks[i + 1]

        overlap = items_a & items_b
        if len(overlap) >= min_overlap:
            continue

        border_items = set()
        for item in items_a:
            for neighbor, _ in adj.get(item, []):
                if neighbor in items_b:
                    border_items.add(neighbor)
                    border_items.add(item)

        items_to_share = border_items - overlap
        needed = min_overlap - len(overlap)
        share_list = list(items_to_share)[:needed]

        for item in share_list:
            items_a.add(item)
            items_b.add(item)

        edges_a = [idx for idx, (a, b, _) in enumerate(pairwise_judgments)
                    if a in items_a and b in items_a]
        edges_b = [idx for idx, (a, b, _) in enumerate(pairwise_judgments)
                    if a in items_b and b in items_b]

        chunks[i] = (items_a, edges_a)
        chunks[i + 1] = (items_b, edges_b)

    return chunks


def _stitch_scores(chunk_results, all_ids, min_score, max_score):
    if len(chunk_results) == 0:
        return {}

    if len(chunk_results) == 1:
        return chunk_results[0]

    final_scores = dict(chunk_results[0])

    for i in range(1, len(chunk_results)):
        current_scores = chunk_results[i]

        overlap_ids = set(final_scores.keys()) & set(current_scores.keys())

        if overlap_ids:
            offsets = [final_scores[oid] - current_scores[oid] for oid in overlap_ids]
            median_offset = sorted(offsets)[len(offsets) // 2]
        else:
            median_offset = 0

        for item_id, score in current_scores.items():
            if item_id not in final_scores:
                adjusted = score + median_offset
                adjusted = max(min_score, min(max_score, adjusted))
                final_scores[item_id] = adjusted

    return final_scores


def chunked_assign_scores(N, min_score, max_score, pairwise_judgments,
                          examples=None, bounds=None, bucket_sizes=None,
                          weights=None, edge_weights=None,
                          distribution_weight=None,
                          time_limit=None, solver_msg=False,
                          progress_callback=None):
    all_ids = set()
    for a, b, _ in pairwise_judgments:
        all_ids.add(a)
        all_ids.add(b)
    if examples:
        all_ids.update(examples.keys())
    if bounds:
        all_ids.update(bounds.keys())
    all_ids = sorted(all_ids)

    if len(all_ids) <= CHUNK_THRESHOLD:
        return assign_scores(
            N, min_score, max_score, pairwise_judgments,
            examples=examples, bounds=bounds,
            bucket_sizes=bucket_sizes, weights=weights,
            edge_weights=edge_weights, distribution_weight=distribution_weight,
            time_limit=time_limit, solver_msg=solver_msg
        )

    print(f"Chunked optimizer: {len(all_ids)} items, {len(pairwise_judgments)} edges — partitioning")

    adj = _build_adjacency(pairwise_judgments)
    chunks = _partition_graph(all_ids, adj, pairwise_judgments)
    print(f"Created {len(chunks)} chunks: {[len(c[0]) for c in chunks]} items each")

    example_map = examples or {}
    bounds_map = bounds or {}

    ew_list = edge_weights or []

    chunk_results = []
    total_violations = 0
    total_edges_solved = 0

    for chunk_idx, (chunk_items, chunk_edge_indices) in enumerate(chunks):
        chunk_judgments = [pairwise_judgments[i] for i in chunk_edge_indices]
        chunk_edge_weights = [ew_list[i] for i in chunk_edge_indices] if ew_list else None

        chunk_examples = {k: v for k, v in example_map.items() if k in chunk_items} or None
        chunk_bounds = {k: v for k, v in bounds_map.items() if k in chunk_items} or None

        chunk_bucket_sizes = None
        if bucket_sizes and distribution_weight:
            ratio = len(chunk_items) / len(all_ids)
            chunk_bucket_sizes = {}
            for b, size in bucket_sizes.items():
                chunk_bucket_sizes[b] = max(0, round(size * ratio))
            diff = len(chunk_items) - sum(chunk_bucket_sizes.values())
            if diff != 0:
                largest_bucket = max(chunk_bucket_sizes, key=chunk_bucket_sizes.get)
                chunk_bucket_sizes[largest_bucket] += diff

        chunk_N = len(chunk_items)

        chunk_dist_weight = None
        if distribution_weight and chunk_bucket_sizes:
            if chunk_edge_weights:
                avg_ew = sum(chunk_edge_weights) / max(len(chunk_edge_weights), 1)
            else:
                avg_ew = 1.0
            chunk_dist_weight = avg_ew * len(chunk_judgments) * 0.5

        chunk_time_limit = time_limit or 10
        max_iter = 5
        current_judgments = chunk_judgments[:]
        current_ew = chunk_edge_weights[:] if chunk_edge_weights else None

        solution = None
        for iteration in range(max_iter):
            solution = assign_scores(
                chunk_N, min_score, max_score, current_judgments,
                examples=chunk_examples,
                bounds=chunk_bounds,
                bucket_sizes=chunk_bucket_sizes,
                weights=weights,
                edge_weights=current_ew,
                distribution_weight=chunk_dist_weight,
                time_limit=chunk_time_limit,
                solver_msg=solver_msg
            )

            if solution["status"] == "Optimal":
                break

            if iteration < max_iter - 1:
                num_remove = max(1, int(len(current_judgments) * 0.15))
                if current_ew:
                    paired = sorted(zip(current_judgments, current_ew), key=lambda x: x[1])
                    paired = paired[num_remove:]
                    current_judgments = [p[0] for p in paired]
                    current_ew = [p[1] for p in paired]
                else:
                    current_judgments = current_judgments[num_remove:]

        if solution and solution["status"] == "Optimal":
            chunk_results.append(solution["assignments"])
            total_violations += solution["consistency"]
            total_edges_solved += len(current_judgments)
            print(f"  Chunk {chunk_idx}: {len(chunk_items)} items, {len(current_judgments)} edges — Optimal")
        else:
            chunk_results.append(solution["assignments"] if solution else {})
            total_edges_solved += len(current_judgments)
            print(f"  Chunk {chunk_idx}: {len(chunk_items)} items — solver status: {solution['status'] if solution else 'None'}")

        if progress_callback:
            progress_callback(chunk_idx + 1, len(chunks))

    final_scores = _stitch_scores(chunk_results, all_ids, min_score, max_score)

    consistency = total_violations if total_edges_solved > 0 else 0

    return {
        "status": "Optimal" if all(r for r in chunk_results) else "Suboptimal",
        "assignments": final_scores,
        "consistency": consistency
    }
