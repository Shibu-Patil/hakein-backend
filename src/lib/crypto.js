import CryptoJS from 'crypto-js';

const KEY = process.env.ENCRYPTION_KEY || 'default-32-char-encryption-key!!';

export function encrypt(text) {
  if (!text) return null;
  return CryptoJS.AES.encrypt(text, KEY).toString();
}

export function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function hashPassword(password) {
  return CryptoJS.SHA256(password + KEY).toString();
}