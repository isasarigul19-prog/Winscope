import { hashAdminPassword } from "../auth.js";
import { StringDecoder } from "node:string_decoder";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Bu komutu etkileşimli bir terminalde çalıştır.");
  process.exit(1);
}
const decoder = new StringDecoder("utf8");
let password = "";
process.stdout.write("WinScope yönetici parolası (en az 12 karakter): ");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", async chunk => {
  const input = decoder.write(chunk);
  for (const ch of input) {
    if (ch === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdout.write("\nİptal edildi.\n");
      process.exit(1);
    }
    if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      try {
        const hash = await hashAdminPassword(password);
        password = "";
        process.stdout.write(hash + "\n");
      } catch (error) {
        password = "";
        console.error(error.message);
        process.exitCode = 1;
      }
      return;
    }
    if (ch === "\u007f" || ch === "\b") password = password.slice(0, -1);
    else if (ch >= " ") password += ch;
  }
});
