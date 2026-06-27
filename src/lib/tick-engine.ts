import { useEffect } from "react";
import { toast } from "sonner";
import { useApp, VOLATILITIES } from "./store";

function settleAndNotify(id: string, exitPrice: number) {
  const before = useApp.getState().trades.find((x) => x.id === id);
  if (!before || before.status !== "open") return;
  useApp.getState().settleTrade(id, exitPrice);
  const after = useApp.getState().trades.find((x) => x.id === id);
  if (!after || after.status === "open") return;
  const won = after.status === "won";
  const pnl = after.pnl ?? 0;
  const sign = pnl >= 0 ? "+" : "";
  const msg = `${after.direction.toUpperCase()} ${won ? "won" : "lost"} · ${sign}$${pnl.toFixed(2)}`;
  if (won) toast.success(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
  else toast.error(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
}

// Box-Muller gaussian
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Global tick engine: emits ticks, settles expired trades. */
export function useTickEngine() {
  const setPrice = useApp((s) => s.setPrice);
  const volatility = useApp((s) => s.volatility);
  const trades = useApp((s) => s.trades);

  useEffect(() => {
    const vol = VOLATILITIES.find((v) => v.id === volatility)?.vol ?? 1;
    const id = window.setInterval(() => {
      const cur = useApp.getState().price;
      const drift = -0.0001 * (cur - 200); // mean reversion ~200
      const change = gauss() * 0.15 * vol + drift;
      const next = Math.max(50, cur + change);
      setPrice(Number(next.toFixed(3)));

      // settle expired
      const now = Date.now();
      for (const t of useApp.getState().trades) {
        if (t.status === "open" && now >= t.expiresAt) {
          settleAndNotify(t.id, useApp.getState().price);
        }
      }
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volatility]);

  // also poll for settlement when trades change (in case interval missed)
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      for (const t of useApp.getState().trades) {
        if (t.status === "open" && now >= t.expiresAt) {
          settleAndNotify(t.id, useApp.getState().price);
        }
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [trades.length]);
}