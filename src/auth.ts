#!/usr/bin/env ts-node
// ─────────────────────────────────────────────────────────────────────────────
//  src/auth.ts
//  Interactive guide to extract the Kite web enctoken from your browser
//  and save it to .env.
//
//  Run: npm run auth
//
//  The enctoken is a session cookie set when you log into kite.zerodha.com.
//  It requires NO API key or API secret — just your regular Zerodha login.
//  It resets daily at 6 AM IST when Kite clears your web session.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import chalk from "chalk";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const KITE_BASE_URL = "https://kite.zerodha.com/oms";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Upsert a key=value line in the .env file */
function writeEnv(key: string, value: string): void {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, "utf8");
}

/** Verify the enctoken works by calling the Kite profile endpoint */
async function verifyEnctoken(enctoken: string): Promise<{ valid: boolean; userId?: string }> {
  try {
    const res = await axios.get(`${KITE_BASE_URL}/user/profile`, {
      headers: {
        Authorization: `enctoken ${enctoken}`,
        "X-Kite-Version": "3",
      },
    });
    const userId: string = res.data?.data?.user_id ?? res.data?.data?.email ?? "unknown";
    return { valid: true, userId };
  } catch {
    return { valid: false };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(chalk.cyan.bold("\n🔐 Zerodha Kite — enctoken Setup\n"));
  console.log(
    chalk.white("This tool extracts your Kite web session token so the agent\n") +
    chalk.white("can access your portfolio without an API key or secret.\n")
  );

  // ── Step 1: Instructions ──────────────────────────────────────────────────

  console.log(chalk.bold.yellow("Step 1:") + chalk.white(" Log in to Kite web\n"));
  console.log("  Open: " + chalk.cyan("https://kite.zerodha.com") + " and sign in.\n");

  await prompt(chalk.grey("  Press Enter once you are logged in..."));
  console.log();

  // ── Step 2: DevTools walkthrough ──────────────────────────────────────────

  console.log(chalk.bold.yellow("Step 2:") + chalk.white(" Open DevTools and find the enctoken cookie\n"));
  console.log(
    chalk.white("  Chrome / Edge:\n") +
    chalk.grey("    F12  →  Application tab  →  Cookies (left sidebar)\n") +
    chalk.grey("    →  https://kite.zerodha.com  →  find row: enctoken\n\n") +
    chalk.white("  Firefox:\n") +
    chalk.grey("    F12  →  Storage tab  →  Cookies\n") +
    chalk.grey("    →  https://kite.zerodha.com  →  find row: enctoken\n\n") +
    chalk.white("  Safari:\n") +
    chalk.grey("    Develop  →  Show Web Inspector  →  Storage  →  Cookies\n\n") +
    chalk.dim("  Quick shortcut: in browser console (F12 → Console), paste:\n") +
    chalk.cyan('    document.cookie.split("; ").find(r => r.startsWith("enctoken"))?.split("=")[1]\n')
  );

  // ── Step 3: Paste token ───────────────────────────────────────────────────

  const enctoken = await prompt(chalk.yellow("Paste your enctoken here: "));

  if (!enctoken) {
    console.error(chalk.red("\n❌ No token provided. Exiting."));
    process.exit(1);
  }

  // ── Step 4: Verify token ──────────────────────────────────────────────────

  console.log(chalk.grey("\n  Verifying token against Kite API..."));
  const { valid, userId } = await verifyEnctoken(enctoken);

  if (!valid) {
    console.error(
      chalk.red("\n❌ Token verification failed.\n") +
      chalk.grey("   Make sure you copied the full enctoken value and are logged in to Kite.\n")
    );
    process.exit(1);
  }

  console.log(chalk.green(`\n✅ Token verified! Logged in as: ${chalk.bold(userId)}`));

  // ── Step 5: Save to .env ──────────────────────────────────────────────────

  writeEnv("KITE_ENCTOKEN", enctoken);

  console.log(chalk.green(`\n✅ KITE_ENCTOKEN saved to ${ENV_PATH}`));
  console.log(
    chalk.grey("\n  ⏰ Remember: The enctoken resets daily at 6 AM IST when Kite\n") +
    chalk.grey("     clears your web session. Re-run this script each morning.\n\n") +
    chalk.white("  You're all set! Try:\n") +
    chalk.cyan("    npm run dev:holdings\n")
  );
}

main().catch((err) => {
  console.error(chalk.red(`\nUnexpected error: ${err.message}`));
  process.exit(1);
});
