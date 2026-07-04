// src/lib/tick-engine.ts
import { useEffect } from "react";
import { toast } from "sonner";
import { useApp, VOLATILITIES } from "./store";

function settleAndNotify(id: string, exitPrice: number) {
  const before = useApp.getState().trades.find((x) => x.id === id);
  if (!before || before.status !== "open") return;
  
  // ✅ Handle async settlement properly
  useApp.getState().settleTrade(id, exitPrice).then((updatedTrade) => {
    if (!updatedTrade) return;
    if (updatedTrade.status === "open") return;
    
    const won = updatedTrade.status === "won";
    const pnl = updatedTrade.pnl ?? 0;
    const sign = pnl >= 0 ? "+" : "";
    const msg = `${updatedTrade.direction.toUpperCase()} ${won ? "won" : "lost"} · ${sign}$${pnl.toFixed(2)}`;
    if (won) toast.success(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
    else toast.error(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
  }).catch((err) => {
    console.error('[settleAndNotify] Failed to settle trade:', err);
    toast.error('Failed to settle trade. Please refresh.');
  });
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
  const isAuthenticated = useApp((s) => s.isAuthenticated);

  // ✅ Only run demo engine if NOT authenticated (demo mode only)
  useEffect(() => {
    // If user is authenticated, they should use real WebSocket data
    // The demo engine is only for non-logged-in users on the /demo route
    if (isAuthenticated) {
      console.log('[TickEngine] Authenticated — using WebSocket data, demo engine disabled');
      return;
    }

    console.log('[TickEngine] Demo mode — using synthetic price engine');
    
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
  }, [volatility, isAuthenticated, setPrice]);

  // ✅ Settlement poll — only run for demo mode, and check trades properly
  useEffect(() => {
    if (isAuthenticated) {
      console.log('[TickEngine] Settlement poll disabled for authenticated users');
      return;
    }

    console.log('[TickEngine] Settlement poll active for demo mode');
    const id = window.setInterval(() => {
      const now = Date.now();
      for (const t of useApp.getState().trades) {
        if (t.status === "open" && now >= t.expiresAt) {
          settleAndNotify(t.id, useApp.getState().price);
        }
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [trades.length, isAuthenticated]);
}