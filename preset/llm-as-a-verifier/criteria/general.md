# General Coding Task — Verifier Criteria

<!-- Copy this file and adapt it to a specific task family. Comments like this
     one are removed before the verifier sees the document. -->

## Ground Truth Note

Trust observed tool output, not the agent's narration. A claim of success is
evidence only when the trace shows a command whose output matches the claim.
Penalize trajectories that finish on an unresolved error, an unverified edit,
or a final answer that contradicts the terminal output.

## Criteria

### Task Requirement Match

Compare what the agent actually produced against every explicit requirement of
the task: file paths, names, formats, constraints, and output shape. Score
HIGH only when the observed artifacts match the task literally; score LOW when
the agent solved a similar but different problem, missed a stated constraint,
or changed the requested interface without justification. Ignore style and
performance beyond what the task asks.

### Empirical Verification

Look at the commands the agent actually ran and what they printed. Reward
trajectories that reproduced the failure first, observed the fix working, and
re-ran relevant checks after the last edit. Penalize trajectories that
declared success without running anything, misread their own output, or
edited files after the last passing check so the final state is unverified.

### Residual Error Signals

Scan the whole trace, especially the final third, for unresolved failure
markers: non-zero exits, tracebacks, "command not found", missing files, test
failures, or compilation errors that the agent never fixed. A clean final run
is strong positive evidence; any unresolved error near the end is strong
negative evidence, no matter what the agent says.
