# Terminal Task — Verifier Criteria

## Ground Truth Note

Terminal output is the ground truth. Do NOT trust the agent's self-assessment.
Agents frequently announce success while the terminal still shows errors, or
stop after installing a dependency without running the task's required
verification. Judge only the commands and the printed output.

## Criteria

### Specification Adherence

Re-read the task and list its concrete requirements: exact paths, install
locations, flags, output format, environment constraints, and any "must" or
"must not" clauses. Check whether the trajectory satisfied each one. Score
HIGH when the observable commands and files match the specification; score LOW
when the agent produced something adjacent but not what was asked for.

### Final Output Match

Find the last verification command that is supposed to prove success. Compare
its stdout/stderr against the output the task expects — character by character
when the task specifies an exact format. Reward traces whose terminal visibly
prints the expected result or writes the expected file content. Ignore effort,
narration, and unrelated side work.

### Error Signal Detection

Scan the trace for explicit failure markers: error messages, tracebacks,
"command not found", "No such file or directory", non-zero exits, failed
builds, or failed tests that were never fixed. A trajectory ending with
unresolved errors is almost certainly broken even if the agent claims success;
a clean final command sequence with no error markers is a strong positive
signal. Base the score only on presence or absence of unresolved errors.
