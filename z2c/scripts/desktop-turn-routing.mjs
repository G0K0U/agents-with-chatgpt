// Session-scoped control ownership. Credentials always remain on Desktop stdio.
export class DesktopTurnRouting {
  turns = new Map();
  requests = new Map();

  claim(client, sessionId, timeoutMs, now = Date.now()) {
    if (typeof sessionId !== "string" || !/^sess_[0-9a-f-]{36}$/i.test(sessionId) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) return false;
    const previous = this.turns.get(sessionId);
    if (previous?.client && previous.expires > now) return false;
    this.turns.set(sessionId, { client, expires: now + timeoutMs });
    return true;
  }

  release(client, sessionId) {
    const turn = this.turns.get(sessionId);
    if (turn?.client === client) turn.client = null;
  }

  disconnect(client) {
    for (const turn of this.turns.values()) if (turn.client === client) turn.client = null;
  }

  route(message, now = Date.now()) {
    if (message.method !== "interaction/requestPermission") return undefined;
    const turn = this.turns.get(message.params?.sessionId);
    if (!turn) return undefined;
    if (!turn.client || turn.expires <= now) return null;
    this.requests.set(String(message.id), { turn, sessionId: message.params.sessionId });
    return turn.client;
  }

  response(client, id, now = Date.now()) {
    const request = this.requests.get(String(id));
    if (!request) return false;
    if (request.turn.client !== client || request.turn.expires <= now) return false;
    this.requests.delete(String(id));
    return true;
  }
}
