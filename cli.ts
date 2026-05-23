#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  src/cli.ts
//  CLI entry point — parse commands and dispatch to the agent
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { Command } from "commander";
import chalk from "chalk";

import {
  runRebalanceCommand,
  runPnLCommand,
  runAgentQuery,
  parseTargetWeights,
} from "./agents/rebalancingAgent";
import { displayResult } from "./utils/display";
import { logger } from "./utils/logger";

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
╔══════════════════════════════════════════════════════╗
║   🏦  Zerodha Portfolio Rebalancing Agent  v1.0.0   ║
║        Powered by LangChain.js + Kite Connect       ║
╚══════════════════════════════════════════════════════╝
`)
  );
}

// ─── CLI Setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("rebalancer")
  .description("Zerodha portfolio rebalancing agent using LangChain.js")
  .version("1.0.0")
  .hook("preAction", () => printBanner());

// ─── Command: rebalance ───────────────────────────────────────────────────────
//
//   rebalancer rebalance --weights "INFY:30,TCS:40,HDFC:30"
//   rebalancer rebalance --weights "INFY 30%, TCS 40%, HDFC 30%" --execute
//   rebalancer rebalance --weights "INFY:30,TCS:40,HDFC:30" --drift 3

program
  .command("rebalance")
  .description(
    "Analyse portfolio against target weights and suggest (or execute) rebalancing trades"
  )
  .requiredOption(
    "-w, --weights <weights>",
    'Target allocation as "SYMBOL:PCT,SYMBOL:PCT" or "SYMBOL PCT%, SYMBOL PCT%"\n' +
      '    Example: --weights "INFY:30,TCS:40,HDFC:30"'
  )
  .option(
    "-e, --execute",
    "Execute the suggested trades (places real orders)",
    false
  )
  .option(
    "-d, --drift <threshold>",
    "Minimum % weight drift to trigger a trade suggestion (default: 2)",
    "2"
  )
  .action(async (opts: { weights: string; execute: boolean; drift: string }) => {
    try {
      logger.info("Running rebalance command", { opts });

      const targetWeights = parseTargetWeights(opts.weights);
      const driftThreshold = parseFloat(opts.drift);

      if (isNaN(driftThreshold) || driftThreshold < 0) {
        console.error(chalk.red("--drift must be a positive number"));
        process.exit(1);
      }

      console.log(chalk.bold("\n🎯 Target Weights:"));
      Object.entries(targetWeights).forEach(([sym, w]) =>
        console.log(`   ${chalk.white(sym.padEnd(15))} ${chalk.cyan(`${w}%`)}`)
      );
      console.log();

      if (opts.execute) {
        console.log(
          chalk.yellow.bold(
            "⚠️  LIVE EXECUTION MODE — real orders will be placed on Zerodha!\n"
          )
        );
      } else {
        console.log(chalk.grey("ℹ️  Dry-run mode (add --execute to place real orders)\n"));
      }

      const result = await runRebalanceCommand({
        targetWeights,
        dryRun: !opts.execute,
        driftThreshold,
      });

      displayResult(result);

      if (!result.success) process.exit(1);
    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${(err as Error).message}\n`));
      logger.debug("CLI error", { stack: (err as Error).stack });
      process.exit(1);
    }
  });

// ─── Command: pnl ────────────────────────────────────────────────────────────
//
//   rebalancer pnl
//   rebalancer pnl --verbose

program
  .command("pnl")
  .description("Show last month's gains and losses per stock")
  .action(async () => {
    try {
      logger.info("Running monthly PnL command");

      const result = await runPnLCommand();
      displayResult(result);

      if (!result.success) process.exit(1);
    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${(err as Error).message}\n`));
      logger.debug("CLI error", { stack: (err as Error).stack });
      process.exit(1);
    }
  });

// ─── Command: query ───────────────────────────────────────────────────────────
//
//   rebalancer query "rebalance my portfolio with INFY 30%, TCS 40%, HDFC 30%"
//   rebalancer query "show me my last month's gains"
//   rebalancer query "what is the current weight of INFY in my portfolio?"

program
  .command("query <prompt>")
  .description(
    "Send a free-form natural language query to the AI agent\n" +
      '    Example: query "rebalance portfolio with target weights INFY 30%, TCS 40%, HDFC 30%"'
  )
  .action(async (prompt: string) => {
    try {
      logger.info("Running agent query", { prompt });
      console.log(chalk.bold(`\n🤖 Query: "${prompt}"\n`));
      console.log(chalk.grey("  Thinking...\n"));

      const response = await runAgentQuery(prompt);

      console.log(chalk.cyan.bold("📝 Agent Response:\n"));
      console.log(response);
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${(err as Error).message}\n`));
      logger.debug("CLI error", { stack: (err as Error).stack });
      process.exit(1);
    }
  });

// ─── Command: holdings ───────────────────────────────────────────────────────

program
  .command("holdings")
  .description("Display current portfolio holdings with weights")
  .action(async () => {
    try {
      const { getHoldingsRaw } = await import("./tools/getHoldings.js");
      const { printHoldingsTable } = await import("./utils/display.js");

      const { holdings, totalValue, totalPnL } = await getHoldingsRaw();

      printHoldingsTable(holdings, totalValue);

      console.log(
        `  Total unrealised PnL : ${
          totalPnL >= 0
            ? chalk.green(`+₹${totalPnL.toFixed(2)}`)
            : chalk.red(`-₹${Math.abs(totalPnL).toFixed(2)}`)
        }\n`
      );
    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ─── Parse & Execute ──────────────────────────────────────────────────────────

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
