#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Reference runner: loads the DEFINITIONS of the plan's throwaway model (evidence/model/resolve_model.py, not copied, not
# changed) and applies its resolve() to scenarios read from stdin. The model's own 20000-run loop (from the line
# "bad = 0" on) is not executed.
# usage: model-ref.py <path to resolve_model.py>   stdin: JSON list of scenarios
#   {"x": id, "versions": [record, ...]}              -> arrival: versions[0] is <x>.json, the others conflict files
#   {"files": {name: record}}                          -> resolve exactly this file set (no arrival simulation)
# stdout: JSON list of {name: canon} (final state of each scenario)
import json, sys

src = open(sys.argv[1], encoding="utf-8").read()
cut = src.index("\nbad = 0")
sys.argv = [sys.argv[0]]            # the model reads sys.argv for its --break switches
ns = {"__name__": "model"}
exec(compile(src[:cut], "resolve_model.py", "exec"), ns)
resolve, canon = ns["resolve"], ns["canon"]

out = []
for sc in json.load(sys.stdin):
    if "files" in sc:
        files = resolve(sc["files"])
    else:
        x, vs = sc["x"], sc["versions"]
        files = {x + ".json": vs[0]}
        for j, v in enumerate(vs[1:], 1):
            files[x + ".conflict-%d.json" % j] = v
            files = resolve(files)
        files = resolve(files)
    out.append({n: canon(r) for n, r in files.items()})
json.dump(out, sys.stdout)
