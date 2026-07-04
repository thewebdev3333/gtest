// src/lib/tick-engine.ts
import { useEffect } from "react";
import { toast } from "sonner";
import { useApp, VOLATILITIES } from "./store";

const settlingIds = new Set<string>();
const GRACE_MS = 3000;

function settleAndNotify(id: string, exitPrice: number) {
  const before = useApp.getState().trades.find((x) => x.id === id);
  if (!before || before.status !== "open") {
    console.log(`[TickEngine] Trade ${id} not open or not found, skipping settlement`);
    return;
  }

  if (settlingIds.has(id)) {
    console.log(`[TickEngine] Trade ${id} already being settled, skipping duplicate`);
    return;
  }
  
  console.log(`[TickEngine] Settling trade ${id} at exit price ${exitPrice}`);
  settlingIds.add(id);

  useApp.getState().settleTrade(id, exitPrice).then((updatedTrade) => {
    if (!updatedTrade) {
      console.log(`[TickEngine] Trade ${id} settlement returned no updated trade`);
      return;
    }
    if (updatedTrade.status === "open") {
      console.log(`[TickEngine] Trade ${id} still open after settlement attempt`);
      return;
    }

    const won = updatedTrade.status === "won";
    const pnl = updatedTrade.pnl ?? 0;
    const sign = pnl >= 0 ? "+" : "";
    const msg = `${updatedTrade.direction.toUpperCase()} ${won ? "won" : "lost"} · ${sign}$${pnl.toFixed(2)}`;
    console.log(`[TickEngine] Trade ${id} settled: ${msg}`);
    if (won) toast.success(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
    else toast.error(msg, { description: `Exit @ ${exitPrice.toFixed(3)}` });
  }).catch((err) => {
    console.error(`[TickEngine] Failed to settle trade ${id}:`, err);
    toast.error('Failed to settle trade. Please refresh.');
  }).finally(() => {
    settlingIds.delete(id);
  });
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function useTickEngine() {
  const setPrice = useApp((s) => s.setPrice);
  const volatility = useApp((s) => s.volatility);
  const trades = useApp((s) => s.trades);
  const isConnected = useApp((s) => s.isConnected);

  // Price engine: fallback to synthetic if WebSocket is not connected
  useEffect(() => {
    if (isConnected) {
      console.log('[TickEngine] WebSocket connected — using real data');
      return;
    }

    console.log('[TickEngine] WebSocket disconnected — using synthetic price engine');
    
    const vol = VOLATILITIES.find((v) => v.id === volatility)?.vol ?? 1;
    const id = window.setInterval(() => {
      const cur = useApp.getState().price;
      const drift = -0.0001 * (cur - 200);
      const change = gauss() * 0.15 * vol + drift;
      const next = Math.max(50, cur + change);
      setPrice(Number(next.toFixed(3)));

      const now = Date.now();
      for (const t of useApp.getState().trades) {
        if (t.status === "open" && now >= t.expiresAt) {
          console.log(`[TickEngine] Synthetic engine: trade ${t.id} expired at ${t.expiresAt}, settling`);
          settleAndNotify(t.id, useApp.getState().price);
        }
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [volatility, isConnected, setPrice]);

  // Settlement poll — ALWAYS runs as a safety net
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const connected = useApp.getState().isConnected;
      for (const t of useApp.getState().trades) {
        if (t.status !== "open") continue;
        const overdue = now >= t.expiresAt;
        if (!overdue) continue;

        const age = now - t.expiresAt;
        if (!connected || age >= GRACE_MS) {
          console.log(`[TickEngine] Poll: trade ${t.id} expired ${age}ms ago, settling`);
          settleAndNotify(t.id, useApp.getState().price);
        } else {
          // Waiting for WS push
          // console.log(`[TickEngine] Poll: trade ${t.id} expired ${age}ms ago, waiting for WS (${GRACE_MS - age}ms remaining)`);
        }
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [trades.length]);
}