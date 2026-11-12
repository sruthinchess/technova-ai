// Password hashing and sessions. Node built-ins only.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { data, save, id, now } from "./store.js";

const KEYLEN = 64;
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = scryptSync(password, salt, KEYLEN);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const session = { token, userId, createdAt: now(), expiresAt: now() + SESSION_DAYS * 864e5 };
  data().sessions.push(session);
  save();
  return session;
}

export function userForToken(token) {
  if (!token) return null;
  const db = data();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (session.expiresAt < now()) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    save();
    return null;
  }
  return db.users.find((u) => u.id === session.userId) || null;
}

export function destroySession(token) {
  const db = data();
  db.sessions = db.sessions.filter((s) => s.token !== token);
  save();
}

export function findUserByEmail(email) {
  const needle = String(email || "").trim().toLowerCase();
  return data().users.find((u) => u.email === needle) || null;
}

export function createUser(email, password, name) {
  const clean = String(email || "").trim().toLowerCase();
  const user = {
    id: id(),
    email: clean,
    name: (name || clean.split("@")[0] || "there").slice(0, 40),
    password: hashPassword(password),
    createdAt: now(),
  };
  data().users.push(user);
  save();
  return user;
}

export function publicUser(user) {
  return user ? { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } : null;
}

export function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const bits = [
    `sid=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === "production" || process.env.SECURE_COOKIES === "1") bits.push("Secure");
  return bits.join("; ");
}

export const clearedCookie = () =>
  `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.SECURE_COOKIES === "1" ? "; Secure" : ""}`;
