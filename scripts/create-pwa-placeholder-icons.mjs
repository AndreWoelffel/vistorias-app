/**
 * Gera PNGs placeholder mínimos em public/icons/ (substitua por arte final).
 * Rode: node scripts/create-pwa-placeholder-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(dir, { recursive: true });

// PNG 1x1 transparente (válido) — troque por ícones 192/512 reais
const tiny = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const files = [
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
  "apple-touch-icon.png",
  "favicon-32.png",
];
for (const f of files) {
  fs.writeFileSync(path.join(dir, f), tiny);
}
console.log("OK:", dir, files.join(", "));
