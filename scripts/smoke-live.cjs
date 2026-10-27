const { WebSocket } = require("ws");

const eventsUrl =
  "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=10&order=volume24hr&ascending=false";

function parseArray(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function main() {
  const response = await fetch(eventsUrl);
  if (!response.ok) throw new Error(`Gamma returned ${response.status}`);
  const events = await response.json();
  const market = events
    .flatMap((event) => event.markets || [])
    .find((candidate) => candidate.acceptingOrders && parseArray(candidate.clobTokenIds).length);
  if (!market) throw new Error("No active market with CLOB assets found");
  const assetId = parseArray(market.clobTokenIds)[0];

  await new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    let done = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for a live book snapshot"));
    }, 15000);

    socket.on("open", () => {
      socket.send(JSON.stringify({ assets_ids: [assetId], type: "market" }));
    });
    socket.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG") return;
      const decoded = JSON.parse(text);
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      const book = messages.find((message) => message.event_type === "book");
      if (!book || done) return;
      done = true;
      clearTimeout(timeout);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          assetId,
          bids: book.bids?.length || 0,
          asks: book.asks?.length || 0,
          timestamp: book.timestamp,
        }) + "\n",
      );
      socket.close();
      resolve();
    });
    socket.on("error", reject);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
