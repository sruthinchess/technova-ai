// Creates an account from the terminal (sign-up is closed in the app).
//   node scripts/create-user.mjs you@example.com "your-password" [name]
import { load, data } from "../lib/store.js";
import { createUser, findUserByEmail } from "../lib/auth.js";

const [email, password, name] = process.argv.slice(2);
if (!email || !password) {
  console.log('usage: node scripts/create-user.mjs <email> <password> [name]');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.log("that doesn't look like an email");
  process.exit(1);
}
if (password.length < 8) {
  console.log("password needs at least 8 characters");
  process.exit(1);
}

load();
if (findUserByEmail(email)) {
  console.log("that email already exists");
  process.exit(1);
}
const user = createUser(email, password, name);
console.log(`created ${user.email} (${data().users.length} account${data().users.length === 1 ? "" : "s"} total)`);
