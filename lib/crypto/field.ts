import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * เข้ารหัส/ถอดรหัสข้อมูลอ่อนไหวระดับ "field" ด้วย CREDENTIAL_ENC_KEY (at-rest)
 *   ใช้กับ: เนื้อหาแชต (chat_messages.content_enc), PII อื่นที่เก็บเป็น ciphertext
 *
 * ★ CREDENTIAL_ENC_KEY ตั้งครั้งเดียว ห้ามเปลี่ยนภายหลัง — ถ้าเปลี่ยน ciphertext เดิมจะถอดไม่ออก
 * ★ ห้าม log plaintext ที่ผ่านฟังก์ชันนี้
 *
 * อัลกอริทึม: AES-256-GCM (ยืนยันความถูกต้องด้วย auth tag)
 * รูปแบบ token: "v1:<iv_b64url>.<tag_b64url>.<ciphertext_b64url>"
 *   - versioned เผื่อหมุน algorithm/คีย์ในอนาคตโดยยังถอดของเก่าได้
 */

const TOKEN_VERSION = "v1";
const IV_BYTES = 12; // มาตรฐาน GCM
const KEY_BYTES = 32; // AES-256
// salt คงที่สำหรับ KDF (deterministic) — ความลับอยู่ที่ CREDENTIAL_ENC_KEY ไม่ใช่ salt
const KDF_SALT = "nova-cx.field.v1";

/** cache คีย์ที่ derive แล้ว (ต่อค่า secret) กัน scrypt ทำงานซ้ำทุกครั้ง */
let cachedSecret: string | null = null;
let cachedKey: Buffer | null = null;

/** อ่าน CREDENTIAL_ENC_KEY จาก env — undefined ถ้ายังไม่ตั้ง (degrade อย่างสุภาพ) */
export function getEncSecret(): string | undefined {
  return process.env.CREDENTIAL_ENC_KEY || undefined;
}

/** true เมื่อพร้อมเข้ารหัส (ตั้ง CREDENTIAL_ENC_KEY แล้ว) */
export function hasEncKey(): boolean {
  return getEncSecret() !== undefined;
}

/** derive คีย์ 32 ไบต์จาก secret ด้วย scrypt (deterministic + cache) */
function deriveKey(secret: string): Buffer {
  if (cachedKey && cachedSecret === secret) return cachedKey;
  const key = scryptSync(secret, KDF_SALT, KEY_BYTES);
  cachedSecret = secret;
  cachedKey = key;
  return key;
}

/**
 * เข้ารหัส plaintext → token (string) — throw ถ้ายังไม่ตั้ง CREDENTIAL_ENC_KEY
 *   caller ที่ต้องการ degrade เมื่อไม่มีคีย์ ให้เช็ค hasEncKey() ก่อน
 */
export function encryptField(plaintext: string): string {
  const secret = getEncSecret();
  if (!secret) {
    throw new Error("CREDENTIAL_ENC_KEY not configured — cannot encrypt field");
  }
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_VERSION,
    `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`,
  ].join(":");
}

/**
 * ถอดรหัส token → plaintext — throw ถ้าคีย์ไม่ตั้ง / token เพี้ยน / auth tag ไม่ผ่าน
 *   (Phase 2 ฝั่งวิเคราะห์ AI จะเรียกใช้)
 */
export function decryptField(token: string): string {
  const secret = getEncSecret();
  if (!secret) {
    throw new Error("CREDENTIAL_ENC_KEY not configured — cannot decrypt field");
  }
  // ★ normalize: token เพี้ยน/version ผิด/auth tag ไม่ผ่าน → โยน error เดียวกันเสมอ
  //   (ไม่แยกสาเหตุ กัน oracle + ให้ caller จับง่าย)
  try {
    const [version, body] = splitOnce(token, ":");
    if (version !== TOKEN_VERSION || !body) throw new Error("bad version");
    const parts = body.split(".");
    if (parts.length !== 3) throw new Error("bad structure");
    const [ivB64, tagB64, ctB64] = parts;
    const key = deriveKey(secret);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("invalid ciphertext");
  }
}

/** แยก string ที่ตัวคั่นตัวแรกเท่านั้น (body อาจมี ':' ไม่ได้เพราะเป็น base64url จึงปลอดภัย) */
function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ""];
  return [s.slice(0, i), s.slice(i + sep.length)];
}
