# Z2C Permission Model

Date: 2026-09-21 (Phase 3 — design; implementation deliberately NOT opened up yet).

ZCode surfaces two interaction kinds to the client attached to the agent (audit §7):
`interaction/requestPermission` (tool approval; risk level low→critical) and
`interaction/requestUserInput` (AskUserQuestion). Today Z2C **rejects all of them
fail-closed** — correct for unattended lanes, where an unanswered ask times the
turn out instead of silently approving anything.

## Policy types (local configuration, persisted as policy — never as credentials)

| Policy | Behavior on `requestPermission` | Behavior on `requestUserInput` |
| --- | --- | --- |
| `LOCAL_ONLY` (default) | Rejected remotely; surfaced in the local UI/CLI; local user may approve/deny. | Rejected remotely; surfaced locally. |
| `AUTO_READONLY` | Auto-approve ONLY tools the agent classifies low-risk read-only (e.g. read/grep/glob); everything else behaves like LOCAL_ONLY. | Rejected remotely; surfaced locally. |
| `WORKSPACE_WRITE_ALLOWED` | Auto-approve writes confined to the authorized workspace path (path-checked against the grant); anything outside or unrecognized behaves like LOCAL_ONLY. | Rejected remotely; surfaced locally. |
| `ASK_USER` | Every ask is forwarded to the paired client as a semantic `zcode_permission_respond` item; nothing executes until a response arrives (bounded TTL, default = deny). | Forwarded the same way. |

Policies are per-workspace, default `LOCAL_ONLY`, changed only by the local user
(management API / CLI). ChatGPT can never escalate its own policy.

## Future semantic surface (not implemented yet by design)

- `zcode_permission_respond {interaction_id, decision: allow|deny}` — valid only for
  a pending interaction in a session owned by the calling principal, valid only for
  one interaction id, and audited. Allow decisions are constrained by the active
  policy: `ASK_USER` may allow a specific single ask; no policy ever grants
  blanket "always allow everything" remotely.
- `zcode_user_input_respond {interaction_id, action, content?}` — same constraints.

## Invariants

1. No unrestricted remote approval. Remote allow is always policy-bounded and per-interaction.
2. Default deny. Unknown interaction kinds, unknown option ids (fail-closed per ZCode's own broker), and TTL-expired asks resolve to deny.
3. Every ask and every decision is audit-logged (`interaction.requested`, `interaction.resolved` with decision + principal — no tool input content).
4. Policy is local user state; it never contains or replaces provider credentials.
5. Readonly (plan) sessions: asks for mutating tools still surface, but the v4 plan invariant means a deny-by-timeout keeps the workspace safe; plan evidence is re-attested at dispatch.
