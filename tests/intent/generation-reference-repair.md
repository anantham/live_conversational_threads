# Generated reference repair test intent

Context: on 3 November 2026 a 20-minute map from `google/gemini-3.5-flash-lite` was rejected at `hierarchy/parent_missing`. The model declared its idea nodes as `node-idea-intro` and referenced them as `idea-intro`. Strict JSON-schema output cannot enforce that references point at declared ids. The owner chose a deterministic, recorded repair (option A) plus a longer map window (option D).

- A reply whose dangling typed references are all fixed by ONE affix operation (add or strip one delimiter-ended prefix, or one delimiter-led suffix) resolves to the declared nodes and is accepted. This covers parents, secondary parents, edge endpoints and thread moments, and the repair is reported with its operation, affix and count.
- References that already resolve are never changed. A reply with no dangling references reports no repair.
- The repair stays strict. If any dangling reference is not fixed by the shared operation, or two different operations would both work, or the affix is not delimiter-bounded (e.g. `top` → `topic`), or the match is at a different level, the reply is rejected exactly as before (same stage and rule). The authored input is never mutated.
- After repair the full validator still runs, so a repair that produces a duplicate or wrong-level link is still rejected.
- Both Worker routes (map `/generate` and the private replay) log every applied repair unconditionally, and `/generate` reports it in the response.
- The map provider window is 90 s, below the browser's 95 s generate deadline, so the server's 408 arrives before the client gives up. Synthetic fixtures only; no provider is called.
