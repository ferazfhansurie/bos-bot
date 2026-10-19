// Staff logins with a username and password, for people who will never pair
// a device or own a work email: a clinic's front desk, a client's sales team.
// The owner creates each login in Settings → People and hands the generated
// password over; the person signs in on the real web app at /pair and gets
// the same ordinary session a pairing code produces, so every gate applies.
//
// Only scrypt hashes are stored (password-logins.json, 0600). A login can be
// found by its username or by its phone number, because front-desk staff
// remember their number. Removing a login or resetting its password revokes
// every session it signed in, through the `password:<id>` user id.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { Scope } from "./sessions.ts";

export type PasswordRole = "member" | "admin";

const loginSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  phone: z.string().optional(),
  role: z.enum(["member", "admin"]),
  salt: z.string(),
  hash: z.string(),
  createdAt: z.number(),
  passwordSetAt: z.number(),
});
type LoginRecord = z.infer<typeof loginSchema>;

export interface PublicPasswordLogin {
  id: string;
  name: string;
  username: string;
  phone?: string;
  role: PasswordRole;
  createdAt: number;
  passwordSetAt: number;
}

export const PASSWORD_USER_PREFIX = "password:";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Lowercase letters, digits, dot, dash, underscore; 2 to 40 characters. */
export function normalizeUsername(value: string): string | null {
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,39}$/.test(name) ? name : null;
}

/** Digits only, with a Malaysian local number (leading 0) put in
 * international form, so "011-2182 0467" and "+60 11 2182 0467" match. */
export function normalizePhone(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "6" + digits;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Three groups of four from an alphabet with no look-alikes: about 59 bits,
 * easy to read out over the phone. */
export function generatePassword(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, "base64"), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString("base64");
}

function publicLogin(record: LoginRecord): PublicPasswordLogin {
  const view: PublicPasswordLogin = { id: record.id, name: record.name, username: record.username, role: record.role, createdAt: record.createdAt, passwordSetAt: record.passwordSetAt };
  if (record.phone) view.phone = record.phone;
  return view;
}

export function passwordScopes(role: PasswordRole): Scope[] {
  return role === "admin" ? ["admin", "client"] : ["client"];
}

export class PasswordLoginError extends Error {}

export class PasswordLogins {
  private logins: LoginRecord[] = [];
  // A fixed hash to compare against when the username is unknown, so a miss
  // costs the same scrypt time as a wrong password.
  private readonly decoySalt = randomBytes(16).toString("base64");
  private readonly decoyHash = hashPassword(randomBytes(16).toString("hex"), this.decoySalt);

  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    if (!existsSync(file)) return;
    const parsed = z.object({ logins: z.array(loginSchema) }).safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`${file} is not a valid password login file`);
    this.logins = parsed.data.logins;
  }

  enabled(): boolean {
    return this.logins.length > 0;
  }

  list(): PublicPasswordLogin[] {
    return this.logins.map(publicLogin);
  }

  get(id: string): PublicPasswordLogin | null {
    const found = this.logins.find((login) => login.id === id);
    return found ? publicLogin(found) : null;
  }

  add(input: { name: string; username: string; phone?: string; role?: PasswordRole }): { login: PublicPasswordLogin; password: string } {
    const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) throw new PasswordLoginError("give the login a name");
    const username = normalizeUsername(input.username);
    if (!username) throw new PasswordLoginError("usernames are 2 to 40 lowercase letters, digits, dots, dashes or underscores");
    let phone: string | undefined;
    if (input.phone?.trim()) {
      phone = normalizePhone(input.phone) ?? undefined;
      if (!phone) throw new PasswordLoginError("that phone number doesn't look right");
    }
    if (this.logins.some((login) => login.username === username)) throw new PasswordLoginError(`the username ${username} is taken`);
    if (phone && this.logins.some((login) => login.phone === phone)) throw new PasswordLoginError("another login already uses that phone number");
    const password = generatePassword();
    const salt = randomBytes(16).toString("base64");
    const now = this.now();
    const record: LoginRecord = { id: randomUUID(), name, username, role: input.role === "admin" ? "admin" : "member", salt, hash: hashPassword(password, salt), createdAt: now, passwordSetAt: now };
    if (phone) record.phone = phone;
    this.logins.push(record);
    this.persist();
    return { login: publicLogin(record), password };
  }

  setRole(id: string, role: PasswordRole): PublicPasswordLogin | null {
    const record = this.logins.find((login) => login.id === id);
    if (!record) return null;
    record.role = role;
    this.persist();
    return publicLogin(record);
  }

  resetPassword(id: string): { login: PublicPasswordLogin; password: string } | null {
    const record = this.logins.find((login) => login.id === id);
    if (!record) return null;
    const password = generatePassword();
    record.salt = randomBytes(16).toString("base64");
    record.hash = hashPassword(password, record.salt);
    record.passwordSetAt = this.now();
    this.persist();
    return { login: publicLogin(record), password };
  }

  remove(id: string): boolean {
    const before = this.logins.length;
    this.logins = this.logins.filter((login) => login.id !== id);
    if (this.logins.length === before) return false;
    this.persist();
    return true;
  }

  /** The login a username (or phone number) and password belong to. */
  verify(identifier: string, password: string): PublicPasswordLogin | null {
    const username = normalizeUsername(identifier);
    const phone = normalizePhone(identifier);
    const record = this.logins.find((login) => (username && login.username === username) || (phone && login.phone === phone));
    const actual = Buffer.from(hashPassword(password.slice(0, 200), record?.salt ?? this.decoySalt), "base64");
    const expected = Buffer.from(record?.hash ?? this.decoyHash, "base64");
    return record && actual.length === expected.length && timingSafeEqual(actual, expected) ? publicLogin(record) : null;
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({ logins: this.logins }, null, 2) + "\n", { mode: 0o600 });
  }
}
