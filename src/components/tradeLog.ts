export interface TradeLogEntry {
  id: number;
  time: string;
  tone: "info" | "good" | "bad";
  message: string;
}
