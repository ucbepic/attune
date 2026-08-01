import random

def sample_connected_pairs(items, seed=None):
    rng = random.Random(seed)
    n = len(items)
    if n < 2:
        return []
    
    m = n * (n + 1) // 4
    m = max(m, n - 1)

    perm = items[:]
    rng.shuffle(perm)

    edges = set()

    for k in range(n - 1):
        a, b = perm[k], perm[k + 1]
        edges.add((a, b) if a < b else (b, a))

    while len(edges) < m:
        a = rng.choice(items)
        b = rng.choice(items)
        if a == b:
            continue
        e = (a, b) if a < b else (b, a)
        edges.add(e)

    return list(edges)