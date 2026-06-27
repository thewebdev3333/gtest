import { useMemo, useState } from "react";
import {
  useApp,
  NEGATIVE_DIRECTIONS,
  formatMoney,
  type ContractType,
  type Direction,
  type DurationUnit,
} from "@/lib/store";
import { placeTrade } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";

const PAYOUT_MULTIPLIER: Record<ContractType, number> = {
  rise_fall: 1.836,
  over_under: 1.85,
  match_differ: 1.236,
  even_odd: 1.95,
};

const UNIT_TO_MS: Record<DurationUnit, number> = {
  ticks: 1000,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

const UNIT_MAX: Record<DurationUnit, number> = {
  ticks: 10,
  seconds: 60,
  minutes: 60,
  hours: 1,
};
const UNIT_MIN: Record<DurationUnit, number> = { ticks: 1, seconds: 5, minutes: 1, hours: 1 };

const STAKE_PRESETS = [2, 5, 10, 25, 50, 100];

function directionOptions(c: ContractType): { id: Direction; label: string }[] {
  switch (c) {
    case "rise_fall":
      return [
        { id: "rise", label: "Rise" },
        { id: "fall", label: "Fall" },
      ];
    case "over_under":
      return [
        { id: "over", label: "Over" },
        { id: "under", label: "Under" },
      ];
    case "match_differ":
      return [
        { id: "match", label: "Match" },
        { id: "differ", label: "Differ" },
      ];
    case "even_odd":
      return [
        { id: "even", label: "Even" },
        { id: "odd", label: "Odd" },
      ];
  }
}

export function TradeControls() {
  const contract = useApp((s) => s.contract);
  const volatility = useApp((s) => s.volatility);
  const price = useApp((s) => s.price);
  const openTrade = useApp((s) => s.openTrade);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);
  const account = useApp((s) => s.account);
  const demoBalance = useApp((s) => s.demoBalance);
  const realBalance = useApp((s) => s.realBalance);
  const syncAll = useApp((s) => s.syncAll);
  const balance = account === "demo" ? demoBalance : realBalance;

  const dirs = directionOptions(contract);
  const [direction, setDirection] = useState<Direction>(dirs[0].id);
  const [unit, setUnit] = useState<DurationUnit>(contract === "match_differ" ? "ticks" : "seconds");
  const [durationVal, setDurationVal] = useState<number>(10);
  const [stake, setStake] = useState<number>(5);
  const [barrier, setBarrier] = useState<number>(0);

  useMemo(() => {
    if (!dirs.some((d) => d.id === direction)) setDirection(dirs[0].id);
  }, [contract]);

  const isNegative = NEGATIVE_DIRECTIONS.includes(direction);
  const payout = stake * PAYOUT_MULTIPLIER[contract];

  const buy = async () => {
    if (stake < 2) {
      toast.error("Minimum stake is $2");
      return;
    }
    if (stake > balance) {
      toast.error("Insufficient balance");
      return;
    }

    try {
      const durationTicks = durationVal * (unit === 'ticks' ? 1 : unit === 'seconds' ? 1 : unit === 'minutes' ? 60 : 3600);
      
      const response = await placeTrade({
        accountType: account,
        symbol: volatility,
        contractType: contract,
        direction,
        selectedDigit: contract === 'over_under' || contract === 'match_differ' ? barrier : undefined,
        stake,
        durationTicks: Math.min(durationTicks, 3600),
      });

      if (response.success) {
        toast.success(`Opened ${direction.toUpperCase()} for $${stake.toFixed(2)}`, {
          description: `Trade #${response.data.contractId.slice(0, 6)} · settles in ${durationVal} ${unit}`,
        });
        
        await syncAll();
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to place trade");
    }
  };

  const allowedUnits: DurationUnit[] =
    contract === "match_differ" || contract === "even_odd" || contract === "over_under"
      ? ["ticks"]
      : ["ticks", "seconds", "minutes", "hours"];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-md bg-card p-2">
        {dirs.map((d) => {
          const active = d.id === direction;
          const neg = NEGATIVE_DIRECTIONS.includes(d.id);
          return (
            <button
              key={d.id}
              onClick={() => setDirection(d.id)}
              className={`rounded-md py-3 text-lg font-bold transition border-2 ${
                active
                  ? neg
                    ? "border-destructive text-destructive"
                    : "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {d.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-md bg-card p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Duration</div>
            <select
              value={unit}
              onChange={(e) => {
                const u = e.target.value as DurationUnit;
                setUnit(u);
                setDurationVal(Math.min(UNIT_MAX[u], Math.max(UNIT_MIN[u], durationVal)));
              }}
              className="bg-transparent text-xs text-muted-foreground capitalize outline-none"
            >
              {allowedUnits.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDurationVal((v) => Math.max(UNIT_MIN[unit], v - 1))}
              className="grid h-7 w-7 place-items-center rounded bg-elevated hover:bg-accent"
            >
              <Minus className="h-4 w-4" />
            </button>
            <Input
              type="number"
              value={durationVal}
              min={UNIT_MIN[unit]}
              max={UNIT_MAX[unit]}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setDurationVal(Math.min(UNIT_MAX[unit], Math.max(UNIT_MIN[unit], n)));
              }}
              className="w-16 bg-transparent text-center text-2xl font-bold"
            />
            <button
              onClick={() => setDurationVal((v) => Math.min(UNIT_MAX[unit], v + 1))}
              className="grid h-7 w-7 place-items-center rounded bg-elevated hover:bg-accent"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Max {UNIT_MAX[unit]} {unit}
        </div>
      </div>

      <div className="rounded-md bg-card p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Stake</div>
            <div className="text-xs text-muted-foreground">USD · min $2</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStake((s) => Math.max(2, +(s - 1).toFixed(2)))}
              className="grid h-7 w-7 place-items-center rounded bg-elevated hover:bg-accent"
            >
              <Minus className="h-4 w-4" />
            </button>
            <div className="flex items-baseline gap-0.5">
              <span className="text-xl">$</span>
              <Input
                type="number"
                min={2}
                step={0.5}
                value={stake}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setStake(Math.max(2, n));
                }}
                className="w-20 bg-transparent text-center text-2xl font-bold"
              />
            </div>
            <button
              onClick={() => setStake((s) => +(s + 1).toFixed(2))}
              className="grid h-7 w-7 place-items-center rounded bg-elevated hover:bg-accent"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {STAKE_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => setStake(p)}
              className={`rounded px-2 py-0.5 text-xs ${
                stake === p ? "bg-primary text-primary-foreground" : "bg-elevated text-muted-foreground hover:text-foreground"
              }`}
            >
              ${p}
            </button>
          ))}
        </div>
      </div>

      {(contract === "over_under" || contract === "match_differ") && (
        <div className="rounded-md bg-card p-3">
          <div className="mb-1 text-sm font-semibold">Last digit prediction</div>
          <div className="grid grid-cols-5 gap-1">
            {Array.from({ length: 10 }, (_, i) => (
              <button
                key={i}
                onClick={() => setBarrier(i)}
                className={`rounded py-2 text-lg font-bold ${
                  barrier === i ? "bg-primary text-primary-foreground" : "bg-elevated text-muted-foreground hover:text-foreground"
                }`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={buy}
        className={`w-full rounded-md py-3 font-bold text-white transition ${
          isNegative ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90"
        }`}
      >
        <div>Buy</div>
        <div className="text-xs font-medium opacity-90">
          Potential Payout: {formatMoney(payout, currency, fxRate)}
        </div>
      </button>
    </div>
  );
}