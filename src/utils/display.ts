// ─────────────────────────────────────────────────────────────────────────────
//  src/utils/display.ts
//  Terminal output formatting: tables, colours, summaries
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";
import { table } from "table";
import { format } from "date-fns";
import { formatINR, formatPct } from "./pnl";
import type {
  AgentResult,
  Holding,
  MonthlyPnLReport,
  PlacedOrder,
  RebalancingPlan,
} from "../types/index";

// ─── Shared Formatters ────────────────────────────────────────────────────────

function coloured(value: number, text: string): string {
  if (value > 0) return chalk.green(text);
  if (value < 0) return chalk.red(text);
  return chalk.grey(text);
}

function badge(label: string, color: "green" | "red" | "yellow" | "cyan"): string {
  return chalk[color].bold(`[${label}]`);
}

// ─── Holdings Table ───────────────────────────────────────────────────────────

export function printHoldingsTable(holdings: Holding[], totalValue: number): void {
  console.log(chalk.bold.cyan("\n📊 Current Portfolio Holdings\n"));

  const headers = [
    chalk.bold("Symbol"),
    chalk.bold("Qty"),
    chalk.bold("Avg Price"),
    chalk.bold("LTP"),
    chalk.bold("Value (₹)"),
    chalk.bold("PnL (₹)"),
    chalk.bold("Day Chg%"),
    chalk.bold("Weight%"),
  ];

  const rows = holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .map((h) => [
      chalk.white(h.symbol),
      h.quantity.toString(),
      formatINR(h.averagePrice),
      formatINR(h.lastPrice),
      chalk.white(formatINR(h.currentValue)),
      coloured(h.pnl, formatINR(h.pnl)),
      coloured(h.dayChangePercent, formatPct(h.dayChangePercent)),
      `${h.weight.toFixed(2)}%`,
    ]);

  rows.push([
    chalk.bold("TOTAL"),
    "",
    "",
    "",
    chalk.bold(formatINR(totalValue)),
    "",
    "",
    "100%",
  ]);

  console.log(
    table([headers, ...rows], {
      border: {
        topBody: "─",
        topJoin: "┬",
        topLeft: "┌",
        topRight: "┐",
        bottomBody: "─",
        bottomJoin: "┴",
        bottomLeft: "└",
        bottomRight: "┘",
        bodyLeft: "│",
        bodyRight: "│",
        bodyJoin: "│",
        joinBody: "─",
        joinLeft: "├",
        joinRight: "┤",
        joinJoin: "┼",
      },
    })
  );
}

// ─── Rebalancing Plan Table ───────────────────────────────────────────────────

export function printRebalancingPlan(plan: RebalancingPlan): void {
  console.log(chalk.bold.cyan("\n⚖️  Rebalancing Plan\n"));

  if (plan.suggestions.length === 0) {
    console.log(
      chalk.green(
        "✅ Portfolio is already within the drift threshold. No trades needed."
      )
    );
    if (plan.skippedSymbols.length > 0) {
      console.log(
        chalk.grey(`   Skipped (below ${plan.weightDriftThreshold}% drift): ${plan.skippedSymbols.join(", ")}`)
      );
    }
    return;
  }

  const headers = [
    chalk.bold("Action"),
    chalk.bold("Symbol"),
    chalk.bold("Qty"),
    chalk.bold("Price (₹)"),
    chalk.bold("Value (₹)"),
    chalk.bold("Current%"),
    chalk.bold("Target%"),
    chalk.bold("Drift"),
  ];

  const rows = plan.suggestions.map((s) => [
    s.action === "BUY"
      ? badge("BUY", "green")
      : badge("SELL", "red"),
    chalk.white(s.symbol),
    s.quantity.toString(),
    formatINR(s.estimatedPrice),
    formatINR(s.estimatedValue),
    `${s.currentWeight.toFixed(1)}%`,
    `${s.targetWeight.toFixed(1)}%`,
    coloured(s.weightDelta, formatPct(s.weightDelta)),
  ]);

  console.log(
    table([headers, ...rows], {
      columns: { 7: { alignment: "right" } },
    })
  );

  // Summary
  console.log(chalk.bold("  Summary:"));
  console.log(`    Total BUY  value : ${chalk.green(formatINR(plan.totalBuyValue))}`);
  console.log(`    Total SELL value : ${chalk.red(formatINR(plan.totalSellValue))}`);
  const netLabel = plan.netCashRequired >= 0 ? "Cash required" : "Cash freed up";
  const netColour = plan.netCashRequired >= 0 ? chalk.yellow : chalk.green;
  console.log(`    ${netLabel}   : ${netColour(formatINR(Math.abs(plan.netCashRequired)))}`);

  if (plan.skippedSymbols.length > 0) {
    console.log(
      chalk.grey(
        `\n  Skipped (drift < ${plan.weightDriftThreshold}%): ${plan.skippedSymbols.join(", ")}`
      )
    );
  }
}

// ─── Monthly PnL Table ────────────────────────────────────────────────────────

export function printPnLReport(report: MonthlyPnLReport): void {
  const { from, to } = report.period;
  const periodLabel = `${format(from, "d MMM yyyy")} → ${format(to, "d MMM yyyy")}`;

  console.log(chalk.bold.cyan(`\n📈 Monthly PnL Report  (${periodLabel})\n`));

  const headers = [
    chalk.bold("Symbol"),
    chalk.bold("Qty"),
    chalk.bold("Open ₹"),
    chalk.bold("Close ₹"),
    chalk.bold("PnL ₹"),
    chalk.bold("PnL %"),
    chalk.bold("Holding ₹"),
  ];

  const rows = report.stocks
    .sort((a, b) => b.pnlPercent - a.pnlPercent)
    .map((s) => [
      chalk.white(s.symbol),
      s.quantity.toString(),
      formatINR(s.openPrice),
      formatINR(s.closePrice),
      coloured(s.pnlAbsolute, formatINR(s.pnlAbsolute)),
      coloured(s.pnlPercent, formatPct(s.pnlPercent)),
      formatINR(s.holdingValue),
    ]);

  console.log(table([headers, ...rows]));

  // Summary
  console.log(chalk.bold("  Portfolio Summary:"));
  console.log(
    `    Total PnL     : ${coloured(report.totalPnLAbsolute, formatINR(report.totalPnLAbsolute))}`
  );
  console.log(
    `    PnL %         : ${coloured(report.totalPnLPercent, formatPct(report.totalPnLPercent))}`
  );
  console.log(`    Holding Value : ${chalk.white(formatINR(report.totalHoldingValue))}`);

  if (report.bestPerformer) {
    console.log(
      `\n    🏆 Best  : ${chalk.green(report.bestPerformer.symbol)} ` +
        `(${formatPct(report.bestPerformer.pnlPercent)})`
    );
  }
  if (report.worstPerformer) {
    console.log(
      `    📉 Worst : ${chalk.red(report.worstPerformer.symbol)} ` +
        `(${formatPct(report.worstPerformer.pnlPercent)})`
    );
  }
  console.log();
}

// ─── Order Results ────────────────────────────────────────────────────────────

export function printOrderResults(orders: PlacedOrder[]): void {
  if (orders.length === 0) return;

  console.log(chalk.bold.cyan("\n📋 Order Execution Results\n"));

  orders.forEach((o) => {
    const icon = o.status === "PLACED" ? "✅" : "❌";
    const status = o.status === "PLACED"
      ? chalk.green("PLACED")
      : chalk.red("FAILED");
    console.log(
      `  ${icon} ${status}  ${o.transactionType} ${o.quantity}x ${o.symbol}` +
        (o.orderId ? `  (Order ID: ${chalk.dim(o.orderId)})` : "") +
        (o.message ? `  — ${chalk.grey(o.message)}` : "")
    );
  });
  console.log();
}

// ─── Master display router ────────────────────────────────────────────────────

export function displayResult(result: AgentResult): void {
  if (!result.success) {
    console.error(chalk.red.bold(`\n❌ Command failed: ${result.error}\n`));
    return;
  }

  if (result.portfolio) {
    printHoldingsTable(result.portfolio.holdings, result.portfolio.totalValue);
  }

  if (result.plan) {
    printRebalancingPlan(result.plan);
  }

  if (result.pnlReport) {
    printPnLReport(result.pnlReport);
  }

  if (result.placedOrders) {
    printOrderResults(result.placedOrders);
  }

  console.log(
    chalk.dim(`\n  ⏱  Completed in ${result.executionTimeMs}ms\n`)
  );
}
