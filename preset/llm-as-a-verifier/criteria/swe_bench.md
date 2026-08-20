# Software Maintenance Task — Verifier Criteria

## Ground Truth Note

Base every judgement on the repository state and the commands the agent ran,
never on its summary. A patch that does not touch the real failure point, a
fix that passes no test, or a final diff that was never run is not a
successful fix.

## Criteria

### Root Cause Identification

Did the agent locate and address the actual cause of the failure? Score HIGH
when the trace shows the failure reproduced, its source located (wrong file,
missing import, bad condition, ...), and the edit targeting exactly that
source. Score LOW when the agent edited a symptom, changed unrelated code, or
never inspected the failing path.

### Patch Quality

Judge the final diff against the surrounding codebase: minimal scope, correct
types and contracts, no unrelated refactors, and compatibility with existing
callers. Reward patches that follow local conventions and add appropriate
tests. Penalize shotgun edits, dead code, or changes that would break
unexercised call sites.

### Verification Completeness

Look for evidence the patch actually works: a relevant test suite run, a
targeted reproduction command, or a build that completed. The last check must
run AFTER the final edit. Score HIGH only when the observed output demonstrates
the fix; score LOW when the agent relied on intuition or ran checks before the
last change.
