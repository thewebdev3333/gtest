// src/components/trade/Chart.tsx
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  LineStyle,
  CrosshairMode,
} from "lightweight-charts";
import { useApp } from "@/lib/store";

export interface ChartHandle {
  zoomIn: () => void;
  zoomOut: () => void;
}

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const lastTimeRef = useRef<number>(0);
  const entryLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const hasReceivedHistoryRef = useRef<boolean>(false);
  const [isReady, setIsReady] = useState(false);

  const price = useApp((s) => s.price);
  const crosshairEnabled = useApp((s) => s.crosshairEnabled);
  const theme = useApp((s) => s.theme);
  const trades = useApp((s) => s.trades);
  const ws = useApp((s) => s.ws);
  const volatility = useApp((s) => s.volatility);

  // ── Setup chart ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    
    const isDark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    const fg = isDark ? "#e6e6e6" : "#222";
    const grid = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: fg,
        attributionLogo: false,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { 
        borderColor: grid, 
        scaleMargins: { top: 0.1, bottom: 0.1 } 
      },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        shiftVisibleRangeOnNewBar: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: number) => {
          const d = new Date((time as number) * 1000);
          return d.toLocaleTimeString([], { 
            hour: "2-digit", 
            minute: "2-digit", 
            second: "2-digit", 
            hour12: false 
          });
        },
      },
      localization: {
        timeFormatter: (time: number) =>
          new Date((time as number) * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
      },
      crosshair: {
        mode: crosshairEnabled ? CrosshairMode.Normal : CrosshairMode.Hidden,
      },
      handleScale: {
        mouseWheel: false,
        axisPressedMouseMove: { time: false, price: true },
        pinch: false,
      },
      autoSize: true,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#00c853",
      topColor: "rgba(0, 200, 83, 0.35)",
      bottomColor: "rgba(0, 200, 83, 0.02)",
      lineWidth: 2,
      priceLineVisible: true,
      priceLineColor: "#00c853",
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });

    chart.priceScale("right").applyOptions({ visible: true });

    // Generate seed data as fallback
    const now = Math.floor(Date.now() / 1000);
    const seed: { time: UTCTimestamp; value: number }[] = [];
    let p = useApp.getState().price;
    for (let i = 120; i > 0; i--) {
      p += (Math.random() - 0.5) * 0.4;
      seed.push({ time: (now - i) as UTCTimestamp, value: Number(p.toFixed(3)) });
    }
    series.setData(seed);

    chartRef.current = chart;
    seriesRef.current = series;
    lastTimeRef.current = now - 1;
    hasReceivedHistoryRef.current = false;
    setIsReady(true);

    chart.timeScale().fitContent();

    // Right-anchored wheel zoom
    const el = containerRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const newSpan = Math.max(10, span * factor);
      ts.setVisibleLogicalRange({ from: range.to - newSpan, to: range.to });
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
      entryLinesRef.current.clear();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setIsReady(false);
    };
  }, [theme]);

  // ── Crosshair toggle ─────────────────────────────────────────────
  useEffect(() => {
    chartRef.current?.applyOptions({
      crosshair: { 
        mode: crosshairEnabled ? CrosshairMode.Normal : CrosshairMode.Hidden 
      },
    });
  }, [crosshairEnabled]);

  // ── ✅ FIX: Reset chart state on volatility change ──────────────
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    
    console.log('[Chart] Volatility changed to:', volatility, '- Resetting chart');
    
    // Clear all data
    seriesRef.current.setData([]);
    
    // Reset history flag and last time
    hasReceivedHistoryRef.current = false;
    lastTimeRef.current = Math.floor(Date.now() / 1000) - 1;
    
    // Remove all entry lines
    for (const [id, line] of entryLinesRef.current) {
      try {
        seriesRef.current.removePriceLine(line);
      } catch {
        // ignore
      }
    }
    entryLinesRef.current.clear();
    
    // Fit content to show empty state
    chartRef.current.timeScale().fitContent();
    
    // Generate fresh seed data for the new symbol
    const now = Math.floor(Date.now() / 1000);
    const seed: { time: UTCTimestamp; value: number }[] = [];
    let p = useApp.getState().price;
    for (let i = 120; i > 0; i--) {
      p += (Math.random() - 0.5) * 0.4;
      seed.push({ time: (now - i) as UTCTimestamp, value: Number(p.toFixed(3)) });
    }
    seriesRef.current.setData(seed);
    chartRef.current.timeScale().fitContent();
    
    console.log('[Chart] Chart reset complete for', volatility);
  }, [volatility]);

  // ── Listen for WebSocket history data ────────────────────────────
  useEffect(() => {
    if (!ws || !seriesRef.current || !isReady) return;

    const handleHistory = (data: any) => {
      // ✅ Only process history for the current symbol
      if (data.symbol !== volatility) {
        console.log('[Chart] Ignoring history for', data.symbol, '(current:', volatility, ')');
        return;
      }
      
      console.log('[Chart] Received history data:', data.ticks?.length || 0, 'ticks for', data.symbol);
      
      if (data.ticks && data.ticks.length > 0) {
        const chartData = data.ticks.map((tick: any) => ({
          time: Math.floor(tick.timestamp / 1000) as UTCTimestamp,
          value: tick.price,
        }));
        
        // Replace seed data with real history
        seriesRef.current?.setData(chartData);
        chartRef.current?.timeScale().fitContent();
        hasReceivedHistoryRef.current = true;
        console.log('[Chart] Loaded history data:', chartData.length, 'points for', data.symbol);
      }
    };

    ws.on('history', handleHistory);

    return () => {
      ws.off('history', handleHistory);
    };
  }, [ws, volatility, isReady]);

  // ── Smooth price updates ────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !isReady) return;
    
    // If we haven't received history yet, use the price to seed
    if (!hasReceivedHistoryRef.current) {
      const t = Math.floor(Date.now() / 1000) as UTCTimestamp;
      const nextTime = Math.max(lastTimeRef.current + 1, t);
      lastTimeRef.current = nextTime;
      seriesRef.current.update({ time: nextTime as UTCTimestamp, value: price });
    }
  }, [price, isReady]);

  // ── Entry markers ────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    
    const lines = entryLinesRef.current;
    const openIds = new Set<string>();
    
    for (const t of trades) {
      if (t.status === "open") {
        openIds.add(t.id);
        if (!lines.has(t.id)) {
          const isNeg = ["fall", "under", "differ", "odd"].includes(t.direction);
          const color = isNeg ? "#ef4444" : "#00c853";
          const line = series.createPriceLine({
            price: t.entryPrice,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${t.direction.toUpperCase()} entry`,
          });
          lines.set(t.id, line);
        }
      }
    }
    
    // Remove lines for trades no longer open
    for (const [id, line] of lines) {
      if (!openIds.has(id)) {
        try {
          series.removePriceLine(line);
        } catch {
          /* noop */
        }
        lines.delete(id);
      }
    }
  }, [trades]);

  // ── Zoom controls via window event ──────────────────────────────
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent).detail as "in" | "out" | "fit";
      const ts = chartRef.current?.timeScale();
      if (!ts) return;
      if (detail === "fit") return ts.fitContent();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const factor = detail === "in" ? 0.7 : 1.4;
      const newSpan = span * factor;
      ts.setVisibleLogicalRange({ from: range.to - newSpan, to: range.to });
    };
    window.addEventListener("gwave:zoom", onZoom as EventListener);
    return () => window.removeEventListener("gwave:zoom", onZoom as EventListener);
  }, []);

  return <div ref={containerRef} className="absolute inset-0" />;
}