// ─────────────────────────────────────────────────────────────────────────────
//  src/utils/logger.ts
//  Structured Winston logger with console and optional file transport
// ─────────────────────────────────────────────────────────────────────────────

import winston from "winston";

const { combine, timestamp, colorize, printf, errors } = winston.format;

// ─── Custom pretty-print format for console ───────────────────────────────────

const IGNORED_META_KEYS = new Set(["level", "message", "timestamp", "stack", "service", "scope"]);

const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const filteredMeta = Object.fromEntries(
    Object.entries(meta).filter(([k]) => !IGNORED_META_KEYS.has(k))
  );
  const metaStr =
    Object.keys(filteredMeta).length > 0
      ? `\n  ${JSON.stringify(filteredMeta, null, 2)}`
      : "";
  return `${ts} [${level}] ${stack ?? message}${metaStr}`;
});

// ─── Logger factory ───────────────────────────────────────────────────────────

function createLogger(service = "zerodha-rebalancer"): winston.Logger {
  const logLevel = process.env.LOG_LEVEL ?? "info";

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: "HH:mm:ss" }),
        errors({ stack: true }),
        consoleFormat
      ),
    }),
  ];

  return winston.createLogger({
    level: logLevel,
    defaultMeta: { service },
    transports,
    exitOnError: false,
  });
}

export const logger = createLogger();

/** Create a child logger scoped to a module/tool */
export function scopedLogger(scope: string): winston.Logger {
  return logger.child({ scope });
}
