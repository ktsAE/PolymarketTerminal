export function SessionOrders({ onClearDry }: { onClearDry(): void }) {
 return <div className="session-orders-note"><span>Session submissions only · Accepted is not a fill · hollow markers are NOT working orders.</span><button onClick={onClearDry}>Clear DRY local</button></div>;
}
