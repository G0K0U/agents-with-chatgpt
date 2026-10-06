# Ordinary ChatGPT local wake

This opt-in MV3 extension wakes one existing ordinary ChatGPT conversation when
the minimal orchestrator persists `audit.required`. No ChatGPT Work, OpenAI API,
external trigger, assistant response scraping, or audit verdict submission is used.

## Install

1. Build/check the checkout using `pnpm typecheck`, `pnpm build`, `pnpm test`.
2. Keep the normal A2C bridge running. Identify the exact orchestrator workspace ID
   and owner ID from your authorized A2C setup. Start this separate local service:
   `pnpm exec tsx scripts/chat-wake.mjs <workspace-id> <owner-id>`.
   It uses the normal external state directory (`C2C_STATE_DIR` if set), refuses
   a state directory inside this repository, and binds only `127.0.0.1:47831`.
   It does not deploy, activate, restart, or expose any public bridge route.
3. In Chrome `chrome://extensions` or Edge `edge://extensions`, enable Developer
   mode, click **Load unpacked**, and select this directory. The user must do this.
4. Sign in to ordinary ChatGPT yourself and choose a dedicated conversation with
   the authorized A2C tools connected. Open extension Options, set its explicit
   `https://chatgpt.com/c/...` URL once, and use the file picker to import
   `<external-state-dir>/chat-wake/<workspace-id>/credential.json`. Save and enable.
   Do not paste credentials into chat, logs, source files, or this repository.
   The generated wake credential is separate from OAuth/admin credentials.
5. Keep the service and browser running. Polling uses a 30-second alarm (Chrome
   may delay it). An exact matching tab is reused and focused; otherwise it opens.
   Leave the composer empty. A draft, login screen, unavailable composer, or
   unavailable send button fails closed. Browser UI changes may require adapter
   updates; CI uses mocks and does not prove live ChatGPT acceptance.

The extension stores only the URL and wake secret in browser-local extension
storage (never sync), restricted to trusted extension contexts. The secret is
sent only to the fixed loopback service and never into the page. Protect the
external state directory and browser profile with your normal user-only OS ACLs;
POSIX creation modes are 0700/0600. No cookie/token/history permission is requested.
The injected adapter accesses only the composer and send control; it never
inspects assistant responses or confirms that ChatGPT received the message.

## Delivery and recovery

Receipts live separately in `chat-wake/<workspace-id>/receipts.json` and use only
`wake_requested`, `wake_submitted`, and `wake_failed`. `wake_submitted` means a
send click was dispatched, **never audit PASS**. The orchestrator's authenticated
claim/submit tools remain the only audit decision path. Completed, paused,
foreign-owner, and already-decided runs are excluded when selecting a wake.
An audit may become stale after selection: independently read it through A2C.

Reservation is persisted before responding to the poll. There is no automatic
retry after a failed or ambiguous delivery, including browser/service crashes or
lost acknowledgements, because this could duplicate a prompt. Inspect the chosen
conversation yourself; use A2C tools to audit manually. For an intentional retry,
stop the sidecar, remove only that event's receipt using a local editor, then
restart. Never edit orchestrator state as part of wake recovery.

To disable, use **Disable and forget credential** in Options and stop the service
with Ctrl+C. To rotate, stop the service, remove its external `credential.json`,
restart, and import the new file. Load only one configured extension/profile;
the sidecar lock prevents two services from sharing the same receipt store.

Reference: [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
and [MV3 service worker lifecycle migration](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers).
