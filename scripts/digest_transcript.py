"""Digest a Claude Code JSONL transcript into readable summaries.

Prints user messages + git commands + a tool-use census to stdout, and writes
a chronological assistant-turn flow digest to a file. Used to verify a handover
doc against the raw transcript without loading 8 MB of JSONL into context.

Usage: python scripts/digest_transcript.py <path-to.jsonl> <flow-out.txt>
"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

src = sys.argv[1]
flow_out = sys.argv[2] if len(sys.argv) > 2 else ".tmp_validation/digest_flow.txt"

records = []
with open(src, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass


def blocks(rec):
    msg = rec.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}], True
    if isinstance(content, list):
        return content, False
    return [], False


type_counts = {}
users = []
flow = []
git_cmds = []
tool_counts = {}
file_ops = []

for rec in records:
    rtype = rec.get("type")
    type_counts[rtype] = type_counts.get(rtype, 0) + 1
    bl, is_string = blocks(rec)

    if rtype == "user":
        texts, has_tr = [], False
        for b in bl:
            if b.get("type") == "text":
                texts.append(b.get("text", ""))
            elif b.get("type") == "tool_result":
                has_tr = True
        text = "\n".join(t for t in texts if t).strip()
        if text:
            users.append({"text": text, "is_string": is_string, "tool_result": has_tr})
            flow.append(("USER", text, []))

    elif rtype == "assistant":
        texts, tools = [], []
        for b in bl:
            bt = b.get("type")
            if bt == "text" and b.get("text", "").strip():
                texts.append(b["text"])
            elif bt == "tool_use":
                name = b.get("name", "?")
                inp = b.get("input") or {}
                tool_counts[name] = tool_counts.get(name, 0) + 1
                if name in ("Bash", "PowerShell"):
                    cmd = inp.get("command", "")
                    desc = inp.get("description", "")
                    tools.append(f"{name}: {desc} :: {cmd[:160]}")
                    if any(k in cmd for k in ("git commit", "git push", "git add")):
                        git_cmds.append(f"[{name}] {cmd}")
                elif name in ("Write", "Edit", "NotebookEdit"):
                    fp = inp.get("file_path", "?")
                    tools.append(f"{name}: {fp}")
                    file_ops.append((name, fp))
                elif name == "Task":
                    tools.append(f"Task: {inp.get('description', '')}")
                else:
                    tools.append(name)
        if texts or tools:
            flow.append(("ASSISTANT", "\n".join(texts), tools))


print(f"=== RECORD TYPES === {type_counts}  (total {len(records)})")
print(f"=== TOOL CENSUS === {dict(sorted(tool_counts.items(), key=lambda x: -x[1]))}")
print(f"=== FILE OPS === {len(file_ops)} Write/Edit calls")

print(f"\n=== USER MESSAGES ({len(users)}) ===")
for i, u in enumerate(users, 1):
    tag = []
    if not u["is_string"]:
        tag.append("list-content")
    if u["tool_result"]:
        tag.append("HAS-TOOL-RESULT")
    print(f"\n----- USER #{i} [{', '.join(tag) or 'plain-string'}] -----")
    print(u["text"][:2400])

print(f"\n\n=== GIT COMMANDS ({len(git_cmds)}) ===")
for i, c in enumerate(git_cmds, 1):
    print(f"\n----- GIT #{i} -----\n{c[:1400]}")

with open(flow_out, "w", encoding="utf-8") as f:
    f.write(f"# CHRONOLOGICAL FLOW DIGEST — {len(flow)} turns\n\n")
    for role, text, tools in flow:
        f.write(f"\n===== {role} =====\n")
        if text:
            snippet = text if len(text) <= 1200 else text[:900] + f"\n  …[{len(text)} chars]…\n" + text[-300:]
            f.write(snippet + "\n")
        for t in tools:
            f.write(f"  >> {t}\n")
print(f"\n\nFlow digest written to {flow_out}")
