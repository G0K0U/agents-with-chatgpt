# Individual local filesystem policy

SessionService owns admission for Individual sends. After workspace and session
ownership authorization it supplies the provider with a turn-scoped execution
grant, including on the bounded stale-busy retry. Write sessions use machine-local
development scope: workspace identity is routing/audit/default cwd, not a sandbox.
Readonly sessions receive a non-writing workspace grant; Write/Edit and Bash
remain denied by the broker. Missing grants and unknown requests fail closed.

The standalone runtime must expose Glob/Grep for machine scope rather than hide
them behind embedded shell search. Existing per-operation broker approval and
plan-mode mutation denial remain authoritative. Acceptance covers Individual
dispatch, retry, sibling/other-drive tools and a real GLM-5.3-Flash/max turn.
