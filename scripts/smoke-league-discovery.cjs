const assert = require("node:assert/strict");

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function main() {
  const sports = await getJson("https://gamma-api.polymarket.com/sports");
  const nba = sports.find((item) => item.sport === "nba");
  assert.ok(nba, "NBA is missing from /sports");
  assert.match(String(nba.series), /^\d+$/, "NBA series id is invalid");

  const events = await getJson(
    `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&series_id=${nba.series}`,
  );
  const scheduled = events.find((event) =>
    event.markets?.some((market) => market.gameStartTime && market.acceptingOrders && market.clobTokenIds),
  );
  assert.ok(scheduled, "No active NBA event exposed gameStartTime and CLOB assets");
  const market = scheduled.markets.find((item) => item.gameStartTime && item.acceptingOrders && item.clobTokenIds);
  const assetIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : JSON.parse(market.clobTokenIds);
  assert.ok(assetIds.length >= 2, "Scheduled market did not expose outcome assets");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    league: nba.name,
    seriesId: String(nba.series),
    event: scheduled.title,
    gameStartTime: market.gameStartTime,
    outcomes: Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes),
    assets: assetIds.length,
  })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
