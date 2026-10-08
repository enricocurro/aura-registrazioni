/**
 * Accesso con due credenziali fisse (da variabili d'ambiente): `user` può solo registrare,
 * `admin` può anche ascoltare e valutare. La sessione è un cookie firmato, senza stato sul
 * server.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "sessione";
const SESSION_HOURS = 12;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const digest = (value) => createHash("sha256").update(String(value)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

export function createAuth({ secret, users }) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  /** Tentativi falliti per indirizzo: frena chi prova le password a raffica. */
  const failures = new Map();

  function blocked(ip) {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  function noteFailure(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
    else entry.count++;
  }

  return {
    /** Restituisce il ruolo, `null` se le credenziali sono sbagliate, `"blocked"` se troppi tentativi. */
    login(ip, username, password) {
      if (blocked(ip)) return "blocked";
      // Si confrontano sempre entrambe le coppie: il tempo di risposta non dice quale nome esiste.
      let role = null;
      for (const user of users) {
        const ok = same(username ?? "", user.username) & same(password ?? "", user.password);
        if (ok) role = user.role;
      }
      if (!role) noteFailure(ip);
      else failures.delete(ip);
      return role;
    },

    issue(role) {
      const payload = Buffer.from(
        JSON.stringify({ role, sid: randomBytes(9).toString("base64url"), exp: Date.now() + SESSION_HOURS * 3600 * 1000 }),
      ).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },

    verify(token) {
      if (typeof token !== "string") return null;
      const [payload, signature] = token.split(".");
      if (!payload || !signature) return null;
      const expected = sign(payload);
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
      try {
        const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!session.exp || session.exp < Date.now()) return null;
        if (session.role !== "user" && session.role !== "admin") return null;
        return session;
      } catch {
        return null;
      }
    },

    maxAgeSeconds: SESSION_HOURS * 3600,
  };
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}
