// src/components/trade/AutoTradeControls.tsx
import { useState, useEffect } from "react";
import { useApp, CONTRACTS, NEGATIVE_DIRECTIONS, formatMoney, type Direction, type ContractType, type VolatilityId } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Play, Square, TrendingUp, TrendingDown, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export function AutoTradeControls() {
  const autoTrade = useApp((s) => s.autoTrade);
  const startAutoTrade = useApp((s) => s.startAutoTrade);
  const stopAutoTrade = useApp((s) => s.stopAutoTrade);
  const account = useApp((s) => s.account);
  const demoBalance = useApp((s) => s.demoBalance);
  const realBalance = useApp((s) => s.realBalance);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);

  const [direction, setDirection] = useState<Direction>("rise");
  const [contract, setContract] = useState<ContractType>("rise_fall");
  const [stake, setStake] = useState<number>(5);
  const [stopLoss, setStopLoss] = useState<number>(20);
  const [takeProfit, setTakeProfit] = useState<number>(10);

  const balance = account === "demo" ? demoBalance : realBalance;
  const isRunning = autoTrade.isRunning;

  const handleStart = () => {
    // Validation
    if (stake < 1) {
      toast.error("Minimum stake is $1");
      return;
    }
    if (stake > balance / 2) {
      toast.error(`Stake cannot exceed half of your balance (${formatMoney(balance / 2, currency, fxRate)})`);
      return;
    }
    if (stopLoss < stake) {
      toast.error(`Stop Loss (${formatMoney(stopLoss, currency, fxRate)}) must be greater than stake (${formatMoney(stake, currency, fxRate)})`);
      return;
    }
    if (takeProfit < stake) {
      toast.error(`Take Profit (${formatMoney(takeProfit, currency, fxRate)}) must be greater than stake (${formatMoney(stake, currency, fxRate)})`);
      return;
    }

    startAutoTrade({
      direction,
      contract,
      stake,
      stopLoss,
      takeProfit,
    });
  };

  const handleStop = () => {
    stopAutoTrade();
  };

  const dirs = [
    { id: "rise", label: "Rise", icon: TrendingUp, color: "text-primary" },
    { id: "fall", label: "Fall", icon: TrendingDown, color: "text-destructive" },
  ] as const;

  return (
    <div className="space-y-4">
      {isRunning ? (
        // Running state
        <Card className="p-4 border-primary/30 bg-primary/5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
                </span>
                <span className="font-semibold">Auto Trading Active</span>
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {autoTrade.direction.toUpperCase()} · {autoTrade.contract.replace('_', ' ')}
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={handleStop}>
              <Square className="h-4 w-4 mr-2" />
              Stop
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-muted-foreground">Trades</div>
              <div className="font-semibold">{autoTrade.tradesCount}</div>
            </div>
            <div>
              <div className="text-muted-foreground">P&L</div>
              <div className={`font-semibold ${autoTrade.totalPnl >= 0 ? "text-primary" : "text-destructive"}`}>
                {autoTrade.totalPnl >= 0 ? "+" : ""}
                {formatMoney(autoTrade.totalPnl, currency, fxRate)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Wins</div>
              <div className="font-semibold text-primary">{autoTrade.wins}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Losses</div>
              <div className="font-semibold text-destructive">{autoTrade.losses}</div>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
            <span>Stop Loss: {formatMoney(autoTrade.stopLoss, currency, fxRate)}</span>
            <span>Take Profit: {formatMoney(autoTrade.takeProfit, currency, fxRate)}</span>
          </div>
        </Card>
      ) : (
        // Setup state
        <div className="space-y-4">
          {/* Direction */}
          <div className="grid grid-cols-2 gap-2">
            {dirs.map((d) => {
              const active = d.id === direction;
              return (
                <button
                  key={d.id}
                  onClick={() => setDirection(d.id as Direction)}
                  className={`flex items-center justify-center gap-2 rounded-lg border-2 p-3 font-semibold transition ${
                    active
                      ? d.id === "rise"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-destructive bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  <d.icon className={`h-4 w-4 ${active ? d.color : ""}`} />
                  {d.label}
                </button>
              );
            })}
          </div>

          {/* Contract type */}
          <div>
            <Label className="text-xs text-muted-foreground">Contract Type</Label>
            <div className="mt-1 flex flex-wrap gap-1">
              {CONTRACTS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setContract(c.id as ContractType)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    c.id === contract
                      ? "bg-primary text-primary-foreground"
                      : "bg-elevated text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Stake */}
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Stake per trade</Label>
              <span className="text-xs font-medium">{formatMoney(stake, currency, fxRate)}</span>
            </div>
            <Input
              type="range"
              min={1}
              max={Math.min(50, balance / 2)}
              step={0.5}
              value={stake}
              onChange={(e) => setStake(parseFloat(e.target.value))}
              className="mt-1"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>$1</span>
              <span>Max: ${Math.min(50, Math.floor(balance / 2))}</span>
            </div>
          </div>

          {/* Stop Loss & Take Profit */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Stop Loss</Label>
                <span className="text-xs font-medium text-destructive">
                  {formatMoney(stopLoss, currency, fxRate)}
                </span>
              </div>
              <Input
                type="range"
                min={stake + 1}
                max={100}
                step={1}
                value={stopLoss}
                onChange={(e) => setStopLoss(parseFloat(e.target.value))}
                className="mt-1"
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Take Profit</Label>
                <span className="text-xs font-medium text-primary">
                  {formatMoney(takeProfit, currency, fxRate)}
                </span>
              </div>
              <Input
                type="range"
                min={stake + 1}
                max={100}
                step={1}
                value={takeProfit}
                onChange={(e) => setTakeProfit(parseFloat(e.target.value))}
                className="mt-1"
              />
            </div>
          </div>

          {/* Risk warning */}
          <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2">
            <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground">
              Auto trading will stop when <strong>Stop Loss</strong> or <strong>Take Profit</strong> is hit.
              Each trade uses the selected direction and contract type.
            </div>
          </div>

          {/* Balance info */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Available balance: {formatMoney(balance, currency, fxRate)}</span>
            <span>Min stake: {formatMoney(1, currency, fxRate)}</span>
          </div>

          {/* Start button */}
          <Button
            onClick={handleStart}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={balance < stake * 2}
          >
            <Play className="h-4 w-4 mr-2" />
            Start Auto Trading
          </Button>

          {balance < stake * 2 && (
            <p className="text-center text-xs text-destructive">
              Insufficient balance. Need at least {formatMoney(stake * 2, currency, fxRate)} to start.
            </p>
          )}
        </div>
      )}
    </div>
  );
}