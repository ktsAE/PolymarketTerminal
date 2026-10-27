import { getAccountStatus } from "../electron/trading.mjs";

const status = getAccountStatus();
if (status.connected || status.armed || status.maxOrderUsd <= 0) {
  throw new Error("Unexpected initial trading state");
}

process.stdout.write(
  `${JSON.stringify({ ok: true, connected: status.connected, armed: status.armed, maxOrderUsd: status.maxOrderUsd })}\n`,
);
