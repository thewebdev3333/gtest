import { useEffect, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesPrimitive,
  type IPrimitivePaneView,
  type IPrimitivePaneRenderer,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
  LineStyle,
  LineType,
  CrosshairMode,
} from "lightweight-charts";
import { useApp } from "@/lib/store";
import { useChartMode, type ChartMode } from "@/lib/chartMode";

export interface ChartHandle {
  zoomIn: () => void;
  zoomOut: () => void;
}

const RIGHT_OFFSET = 12;
const SMOOTH_MS = 380;

function getPalette(theme: string) {
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  return {
    fg: isDark ? "#e6e6e6" : "#222",
    grid: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
    line: "#00c853",
    top: "rgba(0, 200, 83, 0.35)",
    bottom: "rgba(0, 200, 83, 0.02)",
  };
}

class LastTickPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Area"> | null = null;
  private point: { time: number; value: number } | null = null;
  private x: number | null = null;
  private y: number | null = null;
  private color = "#00c853";

  private view: IPrimitivePaneView = {
    zOrder: () => "top",
    renderer: (): IPrimitivePaneRenderer => ({
      draw: (target) => {
        target.useBitmapCoordinateSpace((scope) => {
          if (this.x === null || this.y === null) return;
          const {
            context: ctx,
            bitmapSize,
            horizontalPixelRatio: hr,
            verticalPixelRatio: vr,
          } = scope;
          const x = Math.round(this.x * hr);
          const y = Math.round(this.y * vr);
          if (x > bitmapSize.width) return;

          ctx.save();
          ctx.strokeStyle = this.color;
          ctx.fillStyle = this.color;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(bitmapSize.width, y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 4 * hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
      },
    }),
  };

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<"Area">;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  setPoint(time: number, value: number) {
    this.point = { time, value };
  }

  setColor(color: string) {
    this.color = color;
  }

  updateAllViews() {
    if (!this.chart || !this.series || !this.point) {
      this.x = this.y = null;
      return;
    }
    this.x = this.chart
      .timeScale()
      .timeToCoordinate(this.point.time as UTCTimestamp);
    this.y = this.series.priceToCoordinate(this.point.value);
  }

  paneViews() {
    return [this.view];
  }
}

function cancelAnim(animRef: { current: number | null }) {
  if (animRef.current !== null) {
    cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }
}

function pushPoint(
  time: number,
  value: number,
  seriesRef: { current: ISeriesApi<"Area"> | null },
  primitiveRef: { current: LastTickPrimitive | null },
  lastValueRef: { current: number | null },
) {
  lastValueRef.current = value;
  primitiveRef.current?.setPoint(time, value);
  seriesRef.current?.update({ time: time as UTCTimestamp, value });
}

function afterSetData(
  data: { time: UTCTimestamp; value: number }[],
  primitiveRef: { current: LastTickPrimitive | null },
  animRef: { current: number | null },
  dataLenRef: { current: number },
  lastValueRef: { current: number | null },
) {
  cancelAnim(animRef);
  dataLenRef.current = data.length;
  const last = data[data.length - 1];
  if (last) {
    lastValueRef.current = last.value;
    primitiveRef.current?.setPoint(last.time as number, last.value);
  }
}

function fitToData(
  chartRef: { current: IChartApi | null },
  dataLenRef: { current: number },
) {
  const ts = chartRef.current?.timeScale();
  const n = dataLenRef.current;
  if (!ts || n < 1) return;
  ts.setVisibleLogicalRange({ from: 0, to: n - 1 + RIGHT_OFFSET });
}

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const primitiveRef = useRef<LastTickPrimitive | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastValueRef = useRef<number | null>(null);
  const dataLenRef = useRef<number>(0);
  const animRef = useRef<number | null>(null);
  const entryLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const hasReceivedHistoryRef = useRef<boolean>(false);
  const [isReady, setIsReady] = useState(false);

  const price = useApp((s) => s.price);
  const crosshairEnabled = useApp((s) => s.crosshairEnabled);
  const theme = useApp((s) => s.theme);
  const trades = useApp((s) => s.trades);
  const ws = useApp((s) => s.ws);
  const volatility = useApp((s) => s.volatility);
  const mode = useChartMode();
  const modeRef = useRef<ChartMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = useApp.getState();
    const p = getPalette(state.theme);

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: p.fg,
        attributionLogo: false,
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: {
        borderColor: p.grid,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: p.grid,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: RIGHT_OFFSET,
        shiftVisibleRangeOnNewBar: true,
        fixRightEdge: true,
        fixLeftEdge: true,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
        },
      },
      localization: {
        timeFormatter: (time: number) =>
          new Date(time * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
      },
      crosshair: {
        mode: state.crosshairEnabled
          ? CrosshairMode.Normal
          : CrosshairMode.Hidden,
      },
      handleScale: {
        mouseWheel: false,
        axisPressedMouseMove: { time: false, price: true },
        pinch: false,
      },
      autoSize: true,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: p.line,
      topColor: p.top,
      bottomColor: p.bottom,
      lineWidth: 1,
      lineType: modeRef.current === "smooth" ? LineType.Curved : LineType.Simple,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });

    chart.priceScale("right").applyOptions({ visible: true });

    const primitive = new LastTickPrimitive();
    primitive.setColor(p.line);
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;

    chartRef.current = chart;
    seriesRef.current = series;

    const now = Math.floor(Date.now() / 1000);
    const seed: { time: UTCTimestamp; value: number }[] = [];
    let seedPrice = state.price;
    for (let i = 120; i > 0; i--) {
      seedPrice += (Math.random() - 0.5) * 0.4;
      seed.push({
        time: (now - i) as UTCTimestamp,
        value: Number(seedPrice.toFixed(3)),
      });
    }
    series.setData(seed);
    afterSetData(seed, primitiveRef, animRef, dataLenRef, lastValueRef);

    lastTimeRef.current = now - 1;
    hasReceivedHistoryRef.current = false;
    setIsReady(true);
    fitToData(chartRef, dataLenRef);

    const el = containerRef.current;
    const entryLines = entryLinesRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const factor = event.deltaY > 0 ? 1.15 : 0.87;
      const newSpan = Math.max(10, span * factor);
      ts.setVisibleLogicalRange({
        from: Math.max(0, range.to - newSpan),
        to: range.to,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnim(animRef);
      el.removeEventListener("wheel", onWheel);
      entryLines.clear();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      primitiveRef.current = null;
      setIsReady(false);
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;
      const p = getPalette(theme);
      chart.applyOptions({
        layout: { textColor: p.fg },
        grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
        rightPriceScale: { borderColor: p.grid },
        timeScale: { borderColor: p.grid },
      });
      series.applyOptions({
        lineColor: p.line,
        topColor: p.top,
        bottomColor: p.bottom,
      });
      primitiveRef.current?.setColor(p.line);
    };
    apply();

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme, isReady]);

  useEffect(() => {
    if (!isReady) return;
    if (mode === "tick") cancelAnim(animRef);
    seriesRef.current?.applyOptions({
      lineType: mode === "smooth" ? LineType.Curved : LineType.Simple,
    });
  }, [mode, isReady]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      crosshair: {
        mode: crosshairEnabled
          ? CrosshairMode.Normal
          : CrosshairMode.Hidden,
      },
    });
  }, [crosshairEnabled]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    cancelAnim(animRef);
    seriesRef.current.setData([]);
    hasReceivedHistoryRef.current = false;
    lastTimeRef.current = Math.floor(Date.now() / 1000) - 1;

    for (const [, line] of entryLinesRef.current) {
      try {
        seriesRef.current.removePriceLine(line);
      } catch {
        return;
      }
    }
    entryLinesRef.current.clear();

    const now = Math.floor(Date.now() / 1000);
    const seed: { time: UTCTimestamp; value: number }[] = [];
    let nextPrice = useApp.getState().price;
    for (let i = 120; i > 0; i--) {
      nextPrice += (Math.random() - 0.5) * 0.4;
      seed.push({
        time: (now - i) as UTCTimestamp,
        value: Number(nextPrice.toFixed(3)),
      });
    }
    seriesRef.current.setData(seed);
    afterSetData(seed, primitiveRef, animRef, dataLenRef, lastValueRef);
    fitToData(chartRef, dataLenRef);
  }, [volatility]);

  useEffect(() => {
    if (!ws || !seriesRef.current || !isReady) return;

    const handleHistory = (data: {
      symbol: string;
      ticks?: { timestamp: number; price: number }[];
    }) => {
      if (data.symbol !== volatility) return;
      if (data.ticks && data.ticks.length > 0) {
        const chartData = data.ticks.map((tick) => ({
          time: Math.floor(tick.timestamp / 1000) as UTCTimestamp,
          value: tick.price,
        }));
        seriesRef.current?.setData(chartData);
        afterSetData(chartData, primitiveRef, animRef, dataLenRef, lastValueRef);
        lastTimeRef.current = chartData[chartData.length - 1].time as number;
        fitToData(chartRef, dataLenRef);
        hasReceivedHistoryRef.current = true;
      }
    };

    ws.on("history", handleHistory);
    ws.subscribe(volatility);

    return () => {
      ws.off("history", handleHistory);
    };
  }, [ws, volatility, isReady]);

  useEffect(() => {
    if (!seriesRef.current || !isReady) return;

    const t = Math.floor(Date.now() / 1000);
    const nextTime = Math.max(lastTimeRef.current + 1, t);
    lastTimeRef.current = nextTime;
    dataLenRef.current += 1;

    cancelAnim(animRef);
    const from = lastValueRef.current ?? price;

    if (modeRef.current === "tick" || from === price) {
      pushPoint(nextTime, price, seriesRef, primitiveRef, lastValueRef);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / SMOOTH_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      pushPoint(
        nextTime,
        from + (price - from) * eased,
        seriesRef,
        primitiveRef,
        lastValueRef,
      );
      animRef.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    step(start);

    return () => cancelAnim(animRef);
  }, [price, isReady]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const lines = entryLinesRef.current;
    const openIds = new Set<string>();

    for (const t of trades) {
      if (t.status === "open" && t.volatility === volatility) {
        openIds.add(t.id);
        if (!lines.has(t.id)) {
          const isNeg = ["fall", "under", "differ", "odd"].includes(
            t.direction,
          );
          const color = isNeg ? "#ef4444" : "#00c853";
          const line = series.createPriceLine({
            price: t.entryPrice,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${t.direction.toUpperCase()} entry @ ${t.entryPrice.toFixed(3)}`,
          });
          lines.set(t.id, line);
        }
      }
    }

    for (const [id, line] of lines) {
      if (!openIds.has(id)) {
        try {
          series.removePriceLine(line);
        } catch {
          void id;
        }
        lines.delete(id);
      }
    }
  }, [trades, volatility]);

  useEffect(() => {
    const onZoom = (event: Event) => {
      const detail = (event as CustomEvent).detail as "in" | "out" | "fit";
      const ts = chartRef.current?.timeScale();
      if (!ts) return;
      if (detail === "fit") return fitToData(chartRef, dataLenRef);
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const factor = detail === "in" ? 0.7 : 1.4;
      const newSpan = span * factor;
      ts.setVisibleLogicalRange({
        from: Math.max(0, range.to - newSpan),
        to: range.to,
      });
    };
    window.addEventListener("gwave:zoom", onZoom as EventListener);
    return () =>
      window.removeEventListener("gwave:zoom", onZoom as EventListener);
  }, []);

  return <div ref={containerRef} className="absolute inset-0 z-0" />;
}
