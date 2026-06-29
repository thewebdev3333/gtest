// store.ts
import { create } from "zustand";
import { toast } from "sonner"; // ✅ Import toast at the top
import { 
  getMe, 
  getBalances, 
  getExchangeRate,
  placeTrade,
  getOpenPositions,
  getPositionHistory,
  depositMpesa,
  withdrawMpesa,
  getKYCStatus,
  uploadKYCDocuments,
  getTransactions,
  getWithdrawals,
  MarketWebSocket,
  getToken,
  setToken,
  removeToken,
  mapSymbolToBackend,
  type Position,
  type Transaction,
  type WithdrawalRequest,
} from './api'

export type ContractType = "rise_fall" | "over_under" | "match_differ" | "even_odd";
export type VolatilityId = "v100_1s" | "v50_1s" | "v25_1s";
export type AccountKind = "demo" | "real";
export type Currency = "USD" | "KES";
export type Theme = "dark" | "light" | "system";
export type Direction = "rise" | "fall" | "over" | "under" | "match" | "differ" | "even" | "odd";
export type DurationUnit = "ticks" | "seconds" | "minutes" | "hours";

export const VOLATILITIES: { id: VolatilityId; name: string; vol: number }[] = [
  { id: "v100_1s", name: "Volatility 100 (1s) Index", vol: 1.0 },
  { id: "v50_1s", name: "Volatility 50 (1s) Index", vol: 0.5 },
  { id: "v25_1s", name: "Volatility 25 (1s) Index", vol: 0.25 },
];

export const CONTRACTS: { id: ContractType; label: string }[] = [
  { id: "rise_fall", label: "Rise/Fall" },
  { id: "over_under", label: "Over/Under" },
  { id: "match_differ", label: "Match/Differ" },
  { id: "even_odd", label: "Even/Odd" },
];

export const NEGATIVE_DIRECTIONS: Direction[] = ["fall", "under", "differ", "odd"];

export interface Trade {
  id: string;
  contract: ContractType;
  direction: Direction;
  volatility: VolatilityId;
  stake: number;
  payout: number;
  durationMs: number;
  entryPrice: number;
  entryAt: number;
  expiresAt: number;
  barrier?: number;
  status: "open" | "won" | "lost";
  exitPrice?: number;
  pnl?: number;
}

interface AppState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  fxRate: number;
  account: AccountKind;
  setAccount: (a: AccountKind) => void;
  demoBalance: number;
  realBalance: number;
  deposit: (usd: number, to: AccountKind) => void;
  isAuthenticated: boolean;
  user: { id: string; email: string; name: string } | null;
  setAuthenticated: (status: boolean, user?: { id: string; email: string; name: string }) => void;
  logout: () => void;
  volatility: VolatilityId;
  setVolatility: (v: VolatilityId) => void;
  contract: ContractType;
  setContract: (c: ContractType) => void;
  price: number;
  prevPrice: number;
  setPrice: (p: number) => void;
  resetPrice: (p: number) => void;
  trades: Trade[];
  openTrade: (t: Omit<Trade, "id" | "status" | "entryAt" | "expiresAt"> & { entryAt?: number }) => Trade;
  settleTrade: (id: string, exitPrice: number) => void;
  crosshairEnabled: boolean;
  toggleCrosshair: () => void;
  isLoading: boolean;
  error: string | null;
  ws: MarketWebSocket | null;
  isConnected: boolean;
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected';
  fetchUserData: () => Promise<void>;
  fetchBalances: () => Promise<void>;
  fetchExchangeRate: () => Promise<void>;
  syncTrades: () => Promise<void>;
  syncAll: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
  subscribeToMarket: (symbol: string) => void;
  unsubscribeFromMarket: (symbol: string) => void;
}

const STORAGE_KEY = "gwave_prefs_v1";
const AUTH_KEY = "gwave_auth";

function loadPrefs(): Partial<Pick<AppState, "theme" | "currency" | "account" | "demoBalance" | "realBalance">> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs(s: AppState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      theme: s.theme,
      currency: s.currency,
      account: s.account,
      demoBalance: s.demoBalance,
      realBalance: s.realBalance,
    }),
  );
}

function loadAuth(): { isAuthenticated: boolean; user: { id: string; email: string; name: string } | null } {
  if (typeof window === "undefined") return { isAuthenticated: false, user: null };
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_KEY) || '{"isAuthenticated":false,"user":null}');
  } catch {
    return { isAuthenticated: false, user: null };
  }
}

function saveAuth(isAuthenticated: boolean, user: { id: string; email: string; name: string } | null) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(AUTH_KEY, JSON.stringify({ isAuthenticated, user }));
}

export const useApp = create<AppState>((set, get) => {
  const prefs = loadPrefs();
  const auth = loadAuth();
  
  let wsInstance: MarketWebSocket | null = null;
  
  return {
    theme: prefs.theme ?? "dark",
    setTheme: (t) => {
      set({ theme: t });
      savePrefs(get());
    },
    currency: prefs.currency ?? "USD",
    setCurrency: (c) => {
      set({ currency: c });
      savePrefs(get());
    },
    fxRate: 129.5,

    account: prefs.account ?? "demo",
    setAccount: (a) => {
      set({ account: a });
      savePrefs(get());
    },
    demoBalance: prefs.demoBalance ?? 1204.23,
    realBalance: prefs.realBalance ?? 0,
    deposit: (usd, to) => {
      set((s) =>
        to === "demo"
          ? { demoBalance: s.demoBalance + usd }
          : { realBalance: s.realBalance + usd },
      );
      savePrefs(get());
    },

    isAuthenticated: auth.isAuthenticated,
    user: auth.user,
    setAuthenticated: (status, user) => {
      set({ isAuthenticated: status, user: user || null });
      saveAuth(status, user || null);
      if (status) {
        set({ account: 'real' });
        savePrefs(get());
      }
    },
    logout: () => {
      removeToken();
      set({ 
        isAuthenticated: false, 
        user: null,
        account: 'demo'
      });
      saveAuth(false, null);
      savePrefs(get());
      if (wsInstance) {
        wsInstance.disconnect();
        wsInstance = null;
      }
      set({ ws: null, isConnected: false });
    },

    volatility: "v100_1s",
    setVolatility: (v) => {
      set({ volatility: v });
      const ws = get().ws;
      if (ws && get().isConnected) {
        ws.subscribe(v);
      }
    },
    contract: "rise_fall",
    setContract: (c) => set({ contract: c }),

    price: 204.33,
    prevPrice: 204.33,
    setPrice: (p) => set((s) => ({ price: p, prevPrice: s.price })),
    resetPrice: (p) => set({ price: p, prevPrice: p }),

    trades: [],
    openTrade: (t) => {
      const entryAt = t.entryAt ?? Date.now();
      const trade: Trade = {
        ...t,
        id: Math.random().toString(36).slice(2),
        status: "open",
        entryAt,
        expiresAt: entryAt + t.durationMs,
      };
      const balKey = get().account === "demo" ? "demoBalance" : "realBalance";
      set((s) => ({
        trades: [trade, ...s.trades],
        [balKey]: (s[balKey] as number) - t.stake,
      }) as Partial<AppState>);
      savePrefs(get());
      return trade;
    },
    settleTrade: (id, exitPrice) => {
      const t = get().trades.find((x) => x.id === id);
      if (!t || t.status !== "open") return;
      let won = false;
      const lastDigit = Math.floor(exitPrice * 100) % 10;
      switch (t.direction) {
        case "rise":
          won = exitPrice > t.entryPrice;
          break;
        case "fall":
          won = exitPrice < t.entryPrice;
          break;
        case "over":
          won = lastDigit > (t.barrier ?? 5);
          break;
        case "under":
          won = lastDigit < (t.barrier ?? 5);
          break;
        case "match":
          won = lastDigit === (t.barrier ?? 0);
          break;
        case "differ":
          won = lastDigit !== (t.barrier ?? 0);
          break;
        case "even":
          won = lastDigit % 2 === 0;
          break;
        case "odd":
          won = lastDigit % 2 === 1;
          break;
      }
      const pnl = won ? t.payout - t.stake : -t.stake;
      const credit = won ? t.payout : 0;
      const balKey = get().account === "demo" ? "demoBalance" : "realBalance";
      set((s) => ({
        trades: s.trades.map((x) =>
          x.id === id
            ? { ...x, status: won ? "won" : "lost", exitPrice, pnl }
            : x,
        ),
        [balKey]: (s[balKey] as number) + credit,
      }) as Partial<AppState>);
      savePrefs(get());
    },

    crosshairEnabled: true,
    toggleCrosshair: () => set((s) => ({ crosshairEnabled: !s.crosshairEnabled })),

    isLoading: false,
    error: null,
    ws: null,
    isConnected: false,
    kycStatus: 'none' as const,

    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),

    fetchUserData: async () => {
      try {
        set({ isLoading: true, error: null });
        const response = await getMe();
        
        if (response.success && response.data) {
          const { user, accounts, kycStatus, role } = response.data;
          
          set({
            isAuthenticated: true,
            user: {
              id: user.id,
              email: user.email || '',
              name: user.name || user.email || 'User',
            },
            kycStatus: kycStatus as any,
          });
          
          const demoAccount = accounts.find(a => a.type === 'demo');
          const realAccount = accounts.find(a => a.type === 'real');
          
          set({
            demoBalance: demoAccount?.balance || 0,
            realBalance: realAccount?.balance || 0,
          });
          
          savePrefs(get());
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Failed to fetch user data' });
      } finally {
        set({ isLoading: false });
      }
    },

    fetchBalances: async () => {
      try {
        const response = await getBalances();
        if (response.success) {
          set({
            demoBalance: parseFloat(response.data.demo.usd),
            realBalance: parseFloat(response.data.real.usd),
            fxRate: response.data.rate,
          });
          savePrefs(get());
        }
      } catch (err) {
        console.error('Failed to fetch balances:', err);
      }
    },

    fetchExchangeRate: async () => {
      try {
        const response = await getExchangeRate();
        if (response.success) {
          set({ fxRate: response.data.rate });
        }
      } catch (err) {
        console.error('Failed to fetch exchange rate:', err);
      }
    },

    syncTrades: async () => {
      try {
        const accountType = get().account;
        const response = await getOpenPositions(accountType);
        if (response.success) {
          const trades = response.data.positions.map((p: Position) => ({
            id: p.id,
            contract: p.contract_type as any,
            direction: p.direction as any,
            volatility: p.symbol as any,
            stake: parseFloat(p.stake),
            payout: parseFloat(p.potential_payout),
            durationMs: p.duration_ticks * 1000,
            entryPrice: parseFloat(p.entry_price),
            entryAt: new Date(p.created_at).getTime(),
            expiresAt: new Date(p.created_at).getTime() + (p.duration_ticks * 1000),
            status: (p.status === 'open' ? 'open' : p.outcome === 'win' ? 'won' : 'lost') as 'open' | 'won' | 'lost',
            exitPrice: undefined,
            pnl: undefined,
          }));
          set({ trades });
        }
      } catch (err) {
        console.error('Failed to sync trades:', err);
      }
    },

    syncAll: async () => {
      await Promise.all([
        get().fetchBalances(),
        get().syncTrades(),
        get().fetchExchangeRate(),
      ]);
    },

    connectWebSocket: () => {
      if (wsInstance) {
        wsInstance.disconnect();
        wsInstance = null;
      }

      const token = getToken();
      wsInstance = new MarketWebSocket(token || undefined);
      
      wsInstance.on('tick', (data) => {
        if (data.price) {
          set((s) => ({
            price: data.price,
            prevPrice: s.price,
          }));
        }
      });
      
      wsInstance.on('contract_settled', (data) => {
        get().syncTrades();
        get().fetchBalances();
      });

      // Listen for transaction status updates from WebSocket
      wsInstance.on('transaction_updated', (data) => {
        console.log('[WS] Transaction updated:', data);
        
        // Refresh balances when a transaction updates
        get().fetchBalances();
        
        // Show toast notification based on status
        if (data.status === 'completed') {
          if (data.type === 'deposit') {
            toast.success(`Deposit of $${data.amount_usd.toFixed(2)} completed successfully!`);
          } else if (data.type === 'withdrawal') {
            toast.success(`Withdrawal of $${data.amount_usd.toFixed(2)} completed!`);
          }
        } else if (data.status === 'failed') {
          if (data.type === 'deposit') {
            toast.error('Deposit failed. Please try again.');
          } else if (data.type === 'withdrawal') {
            toast.error('Withdrawal failed. Please contact support.');
          }
        }
      });
      
      wsInstance.connect();
      
      wsInstance.on('connected', () => {
        set({ isConnected: true });
        const symbol = get().volatility;
        wsInstance?.subscribe(symbol);
      });
      
      wsInstance.on('disconnected', () => {
        set({ isConnected: false });
      });
      
      set({ ws: wsInstance });
    },

    disconnectWebSocket: () => {
      if (wsInstance) {
        wsInstance.disconnect();
        wsInstance = null;
      }
      set({ ws: null, isConnected: false });
    },

    subscribeToMarket: (symbol: string) => {
      const ws = get().ws;
      if (ws) {
        ws.subscribe(symbol);
      }
    },

    unsubscribeFromMarket: (symbol: string) => {
      const ws = get().ws;
      if (ws) {
        ws.unsubscribe(symbol);
      }
    },
  };
});

export function formatMoney(usd: number, currency: Currency, fxRate: number): string {
  const v = currency === "USD" ? usd : usd * fxRate;
  const symbol = currency === "USD" ? "$" : "KSh ";
  const formatted = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}${symbol}${formatted}`;
}