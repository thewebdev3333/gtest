import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import GLogo from "@/components/layout/GLogo";
import {
  ArrowRight,
  ShieldCheck,
  Zap,
  Globe2,
  TrendingUp,
  Wallet,
  LineChart,
  CheckCircle2,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "G Wave — Trade synthetic indices, 24/7" },
      {
        name: "description",
        content:
          "G Wave is the fast, secure way to trade synthetic indices. Live markets, instant deposits, withdrawals 24/7.",
      },
      { property: "og:title", content: "G Wave — Trade smarter, anytime" },
      {
        property: "og:description",
        content:
          "Trade volatility indices with real-time charts, instant settlement, and 24/7 withdrawals.",
      },
    ],
  }),
  component: Landing,
});

const NAMES = [
  "Daniel K.", "Amina S.", "Brian O.", "Lerato M.", "Carlos R.",
  "Wei Z.", "Aisha B.", "Tom L.", "Priya N.", "Diego F.",
  "Hassan A.", "Maya K.", "Jonas H.", "Sofia P.", "Ravi T.",
  "Naledi M.", "Yuki S.", "Leo G.", "Zanele D.", "Omar R.",
];
const COUNTRIES = ["🇰🇪","🇿🇦","🇳🇬","🇧🇷","🇮🇳","🇵🇭","🇮🇩","🇲🇽","🇪🇬","🇦🇪"];
const METHODS = ["M-Pesa", "Bank Wire", "USDT TRC-20", "Visa", "PayPal"];

function genWithdrawal(id: number) {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const flag = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const method = METHODS[Math.floor(Math.random() * METHODS.length)];
  const amount = Math.floor(50 + Math.random() * 9950);
  return { id, name, flag, method, amount };
}

function LiveWithdrawals() {
  const [items, setItems] = useState<ReturnType<typeof genWithdrawal>[]>([]);
  useEffect(() => {
    setItems(Array.from({ length: 8 }, (_, i) => genWithdrawal(i)));
    let n = 8;
    const id = window.setInterval(() => {
      n += 1;
      setItems((prev) => [genWithdrawal(n), ...prev].slice(0, 8));
    }, 2200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
          </span>
          <h3 className="text-sm font-semibold">Live withdrawals</h3>
        </div>
        <span className="text-xs text-muted-foreground">Updated in real time</span>
      </div>
      <ul className="divide-y divide-border min-h-[400px]">
        {items.map((it, idx) => (
          <li
            key={it.id}
            className={`flex items-center justify-between py-2.5 text-sm ${
              idx === 0 ? "animate-in fade-in slide-in-from-top-2 duration-500" : ""
            }`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-elevated text-base">
                {it.flag}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{it.name}</div>
                <div className="truncate text-xs text-muted-foreground">{it.method}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono font-semibold text-primary">
                ${it.amount.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                withdrew
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MARKETS = [
  { sym: "VIX 100 (1s)", price: 1234.56, chg: 1.24 },
  { sym: "VIX 75",       price: 987.43,  chg: -0.55 },
  { sym: "VIX 50",       price: 4321.98, chg: 0.81 },
  { sym: "VIX 25",       price: 555.21,  chg: 2.13 },
  { sym: "Crash 1000",   price: 8204.10, chg: -1.07 },
  { sym: "Boom 1000",    price: 6892.55, chg: 0.42 },
];

function Ticker() {
  return (
    <div className="overflow-hidden border-y border-border bg-card/50">
      <div className="flex animate-[wave_40s_linear_infinite] gap-8 whitespace-nowrap py-3 text-sm">
        {[...MARKETS, ...MARKETS, ...MARKETS].map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="font-semibold">{m.sym}</span>
            <span className="font-mono text-muted-foreground">{m.price.toFixed(2)}</span>
            <span className={m.chg >= 0 ? "text-primary" : "text-destructive"}>
              {m.chg >= 0 ? "+" : ""}{m.chg.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
      <style>{`@keyframes wave { from {transform:translateX(0)} to {transform:translateX(-33.333%)} }`}</style>
    </div>
  );
}

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-6">
          <Link to="/" className="flex items-center gap-2">
            <GLogo className="h-8 w-8 text-primary" />
            <span className="text-xl font-bold tracking-tight">Wave</span>
          </Link>
          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#markets" className="hover:text-foreground">Markets</a>
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#withdrawals" className="hover:text-foreground">Live activity</a>
            <a href="#security" className="hover:text-foreground">Security</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="hidden sm:inline-flex">
              <Button variant="ghost" size="sm">Log in</Button>
            </Link>
            <Link to="/signup">
              <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90">
                Sign up
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_30%_20%,oklch(0.72_0.19_152/0.18),transparent_55%),radial-gradient(circle_at_80%_70%,oklch(0.6_0.2_280/0.15),transparent_55%)]" />
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 md:grid-cols-2 md:px-6 md:py-24">
          <div className="flex flex-col justify-center">
            <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              Markets open 24/7 · Withdrawals in seconds
            </div>
            <h1 className="text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Trade smarter.<br />
              <span className="bg-gradient-to-r from-primary to-emerald-300 bg-clip-text text-transparent">
                Anytime, anywhere.
              </span>
            </h1>
            <p className="mt-5 max-w-lg text-base text-muted-foreground md:text-lg">
              G Wave brings institutional-grade synthetic index trading to your pocket.
              Real-time charts, low fees, and instant settlement — all in one app.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup">
                <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  Get started <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link to="/trade">
                <Button size="lg" variant="outline">Try demo</Button>
              </Link>
            </div>
            <div className="mt-10 grid max-w-md grid-cols-3 gap-6 text-sm">
              <Stat n="$4.2B+" l="Volume traded" />
              <Stat n="1.8M+" l="Active users" />
              <Stat n="180+" l="Countries" />
            </div>
          </div>

          <div id="withdrawals" className="relative">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-br from-primary/15 to-transparent blur-2xl" />
            <LiveWithdrawals />
          </div>
        </div>
      </section>

      <Ticker />

      <section id="markets" className="mx-auto max-w-7xl px-4 py-20 md:px-6">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Popular markets</h2>
            <p className="mt-2 text-muted-foreground">Real-time, 24/7 — no overnight gaps.</p>
          </div>
          <Link to="/trade" className="text-sm text-primary hover:underline">
            Explore all markets →
          </Link>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-elevated text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Market</th>
                <th className="px-4 py-3 text-right font-medium">Last price</th>
                <th className="px-4 py-3 text-right font-medium">24h change</th>
                <th className="hidden px-4 py-3 text-right font-medium md:table-cell">Trade</th>
              </tr>
            </thead>
            <tbody>
              {MARKETS.map((m) => (
                <tr key={m.sym} className="border-b border-border/60 last:border-0 hover:bg-elevated/40">
                  <td className="px-4 py-3 font-semibold">{m.sym}</td>
                  <td className="px-4 py-3 text-right font-mono">${m.price.toFixed(2)}</td>
                  <td className={`px-4 py-3 text-right font-mono ${m.chg >= 0 ? "text-primary" : "text-destructive"}`}>
                    {m.chg >= 0 ? "+" : ""}{m.chg.toFixed(2)}%
                  </td>
                  <td className="hidden px-4 py-3 text-right md:table-cell">
                    <Link to="/trade">
                      <Button size="sm" variant="outline">Trade</Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="features" className="border-t border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-4 py-20 md:px-6">
          <div className="mb-12 max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Built for serious traders</h2>
            <p className="mt-2 text-muted-foreground">
              Powerful tools, transparent fees, and the speed of a modern exchange.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Feature icon={Zap} title="Instant execution" desc="Sub-second order matching, even during peak volatility." />
            <Feature icon={LineChart} title="Pro-grade charts" desc="Live tick data with TradingView-quality visuals." />
            <Feature icon={Wallet} title="Instant withdrawals" desc="Cash out via M-Pesa, bank, or crypto in seconds." />
            <Feature icon={ShieldCheck} title="Bank-level security" desc="Cold storage, 2FA, and 24/7 monitoring." />
            <Feature icon={Globe2} title="Global access" desc="Trade from 180+ countries — no overnight gaps." />
            <Feature icon={TrendingUp} title="Volatility indices" desc="Unique synthetic markets that never sleep." />
          </div>
        </div>
      </section>

      <section id="security" className="mx-auto max-w-7xl px-4 py-20 md:px-6">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Your assets, protected.</h2>
            <p className="mt-3 text-muted-foreground">
              We hold the majority of customer funds in cold wallets, with multi-sig controls and
              real-time risk monitoring.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Proof of reserves published monthly",
                "Two-factor authentication on every account",
                "End-to-end encrypted payment channels",
                "$300M risk reserve fund",
              ].map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Tile k="99.99%" v="Uptime SLA" />
            <Tile k="< 50ms" v="Avg. order latency" />
            <Tile k="256-bit" v="AES encryption" />
            <Tile k="24/7" v="Customer support" />
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto max-w-7xl px-4 py-20 text-center md:px-6">
          <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
            Start trading in 60 seconds.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Open an account for free and explore the markets with a $10,000 demo balance.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/signup">
              <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90">
                Create account
              </Button>
            </Link>
            <Link to="/trade">
              <Button size="lg" variant="outline">Try demo</Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-card/40">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 md:grid-cols-4 md:px-6">
          <div>
            <div className="flex items-center gap-2">
              <GLogo className="h-6 w-6 text-primary" />
              <span className="font-bold">Wave</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              The fastest way to trade synthetic indices.
            </p>
          </div>
          <FooterCol title="Product" items={["Markets", "Trade", "Wallet", "Mobile app"]} />
          <FooterCol title="Company" items={["About", "Careers", "Press", "Contact"]} />
          <FooterCol title="Legal" items={["Terms", "Privacy", "Risk disclosure", "Cookies"]} />
        </div>
        <div className="border-t border-border px-4 py-5 text-center text-xs text-muted-foreground md:px-6">
          © 2026 G Wave. Trading involves risk. Not suitable for everyone.
        </div>
      </footer>
    </div>
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div>
      <div className="text-2xl font-bold">{n}</div>
      <div className="text-xs text-muted-foreground">{l}</div>
    </div>
  );
}

function Feature({ icon: Icon, title, desc }: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 transition hover:border-primary/40">
      <div className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}

function Tile({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-2xl font-bold text-primary">{k}</div>
      <div className="text-xs text-muted-foreground">{v}</div>
    </div>
  );
}

function FooterCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-sm font-semibold">{title}</div>
      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
        {items.map((i) => (
          <li key={i}><a className="hover:text-foreground" href="#">{i}</a></li>
        ))}
      </ul>
    </div>
  );
}
