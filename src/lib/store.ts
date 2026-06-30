// store.ts
import { create } from "zustand";
import { toast } from "sonner";
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

export const PAYOUT_MULTIPLIER: Record<ContractType, number> = {
  rise_fall: 1.836,
  over_under: 1.85,
  match_differ: 1.236,
  even_odd: 1.95,
};

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

export interface AutoTradeConfig {
  enabled: boolean;
  direction: Direction;
  contract: ContractType;
  volatility: VolatilityId;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxTrades?: number;
  isRunning: boolean;
  totalPnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
  startedAt: number | null;
}

interface AppState {
  // Theme & UI
  theme: Theme;
  setTheme: (t: Theme) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  fxRate: number;
  
  // Account
  account: AccountKind;
  setAccount: (a: AccountKind) => void;
  demoBalance: number;
  realBalance: number;
  deposit: (usd: number, to: AccountKind) => void;
  
  // Auth
  isAuthenticated: boolean;
  user: { id: string; email: string; name: string } | null;
  setAuthenticated: (status: boolean, user?: { id: string; email: string; name: string }) => void;
  logout: () => void;
  
  // Trading
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
  
  // Chart
  crosshairEnabled: boolean;
  toggleCrosshair: () => void;
  
  // Loading & Errors
  isLoading: boolean;
  error: string | null;
  
  // WebSocket
  ws: MarketWebSocket | null;
  isConnected: boolean;
  
  // KYC
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected';
  
  // Auto Trade
  autoTrade: AutoTradeConfig;
  startAutoTrade: (config: Partial<AutoTradeConfig>) => void;
  stopAutoTrade: () => void;
  placeAutoTrade: () => Promise<void>;
  handleAutoTradeSettlement: (trade: Trade) => void;
  
  // Data fetching
  fetchUserData: () => Promise<void>;
  fetchBalances: () => Promise<void>;
  fetchExchangeRate: () => Promise<void>;
  syncTrades: () => Promise<void>;
  syncAll: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  // WebSocket management
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
  subscribeToMarket: (symbol: string) => void;
  unsubscribeFromMarket: (symbol: string) => void;
}

const STORAGE_KEY = "gwave_prefs_v1";
const AUTH_KEY = "gwave_auth";

// ── Persistence Helpers ──────────────────────────────────────────

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

const initialAutoTrade: AutoTradeConfig = {
  enabled: false,
  direction: "rise",
  contract: "rise_fall",
  volatility: "v100_1s",
  stake: 5,
  stopLoss: 20,
  takeProfit: 10,
  maxTrades: undefined,
  isRunning: false,
  totalPnl: 0,
  tradesCount: 0,
  wins: 0,
  losses: 0,
  startedAt: null,
};

// ── Store ──────────────────────────────────────────────────────────

export const useApp = create<AppState>((set, get) => {
  const prefs = loadPrefs();
  const auth = loadAuth();
  
  let wsInstance: MarketWebSocket | null = null;
  
  return {
    // ── Theme ──────────────────────────────────────────────────────
    theme: prefs.theme ?? "dark",
    setTheme: (t) => {
      set({ theme: t });
      savePrefs(get());
    },
    
    // ── Currency ──────────────────────────────────────────────────
    currency: prefs.currency ?? "USD",
    setCurrency: (c) => {
      set({ currency: c });
      savePrefs(get());
    },
    fxRate: 129.5,

    // ── Account ───────────────────────────────────────────────────
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

    // ── Auth ──────────────────────────────────────────────────────
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

    // ── Volatility & Contract ────────────────────────────────────
    volatility: "v100_1s",
    setVolatility: (v) => {
      const prev = get().volatility;
      const ws = get().ws;
      if (ws && get().isConnected && prev !== v) {
        ws.unsubscribe(prev);
        console.log(`[Store] Unsubscribed from ${prev}`);
      }
      set({ volatility: v });
      if (ws && get().isConnected) {
        ws.subscribe(v);
        console.log(`[Store] Subscribed to ${v}`);
      }
    },
    contract: "rise_fall",
    setContract: (c) => set({ contract: c }),

    // ── Price ─────────────────────────────────────────────────────
    price: 204.33,
    prevPrice: 204.33,
    setPrice: (p) => set((s) => ({ price: p, prevPrice: s.price })),
    resetPrice: (p) => set({ price: p, prevPrice: p }),

    // ── Trades ────────────────────────────────────────────────────
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
      
      // ✅ Auto Trade: Check if this trade was part of auto trading
      const autoTrade = get().autoTrade;
      if (autoTrade.isRunning) {
        get().handleAutoTradeSettlement(t);
      }
    },

    // ── Chart ─────────────────────────────────────────────────────
    crosshairEnabled: true,
    toggleCrosshair: () => set((s) => ({ crosshairEnabled: !s.crosshairEnabled })),

    // ── Loading & Errors ─────────────────────────────────────────
    isLoading: false,
    error: null,
    ws: null,
    isConnected: false,
    kycStatus: 'none' as const,

    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),

    // ── Auto Trade ────────────────────────────────────────────────
    autoTrade: initialAutoTrade,

    startAutoTrade: (config) => {
      const state = get();
      const current = state.autoTrade;
      
      if (current.isRunning) {
        toast.warning("Auto trading is already running");
        return;
      }
      
      const stake = config.stake || current.stake;
      const balKey = state.account === "demo" ? "demoBalance" : "realBalance";
      const balance = state[balKey] as number;
      
      if (balance < stake * 2) {
        toast.error(`Insufficient balance. Need at least ${formatMoney(stake * 2, state.currency, state.fxRate)} to start.`);
        return;
      }
      
      set({
        autoTrade: {
          ...current,
          ...config,
          enabled: true,
          isRunning: true,
          totalPnl: 0,
          tradesCount: 0,
          wins: 0,
          losses: 0,
          startedAt: Date.now(),
          stake: stake,
        }
      });
      
      toast.success("Auto Trading started! 🚀", {
        description: `Direction: ${config.direction || current.direction} · Stop Loss: $${config.stopLoss || current.stopLoss} · Take Profit: $${config.takeProfit || current.takeProfit}`
      });
      
      // Place first trade immediately
      setTimeout(() => {
        get().placeAutoTrade();
      }, 500);
    },

    stopAutoTrade: () => {
      const current = get().autoTrade;
      if (!current.isRunning) return;
      
      const duration = current.startedAt ? Math.round((Date.now() - current.startedAt) / 1000 / 60) : 0;
      
      set({
        autoTrade: {
          ...current,
          isRunning: false,
          enabled: false,
        }
      });
      
      const state = get();
      toast.info(`Auto Trading stopped after ${duration} minute${duration !== 1 ? 's' : ''}`, {
        description: `Trades: ${current.tradesCount} · P&L: ${formatMoney(current.totalPnl, state.currency, state.fxRate)}`
      });
    },

    placeAutoTrade: async () => {
      const state = get();
      const { autoTrade } = state;
      
      if (!autoTrade.isRunning) {
        return;
      }
      
      // Check if we've reached stop loss
      if (autoTrade.totalPnl <= -autoTrade.stopLoss) {
        toast.error(`Auto Trading stopped: Stop Loss hit (${formatMoney(autoTrade.totalPnl, state.currency, state.fxRate)})`);
        state.stopAutoTrade();
        return;
      }
      
      // Check if we've reached take profit
      if (autoTrade.totalPnl >= autoTrade.takeProfit) {
        toast.success(`Auto Trading finished: Take Profit hit (${formatMoney(autoTrade.totalPnl, state.currency, state.fxRate)}) 🎉`);
        state.stopAutoTrade();
        return;
      }
      
      // Check max trades
      if (autoTrade.maxTrades && autoTrade.tradesCount >= autoTrade.maxTrades) {
        toast.info(`Auto Trading finished: Max trades (${autoTrade.maxTrades}) reached`);
        state.stopAutoTrade();
        return;
      }
      
      // Check balance
      const balKey = state.account === "demo" ? "demoBalance" : "realBalance";
      const balance = state[balKey] as number;
      if (balance < autoTrade.stake) {
        toast.error("Auto Trading stopped: Insufficient balance");
        state.stopAutoTrade();
        return;
      }
      
      // Place the trade
      try {
        const payout = autoTrade.stake * PAYOUT_MULTIPLIER[autoTrade.contract];
        const durationMs = 60000; // 1 minute default
        
        // Get current price
        const currentPrice = state.price;
        
        // Open the trade
        const trade = state.openTrade({
          contract: autoTrade.contract,
          direction: autoTrade.direction,
          volatility: autoTrade.volatility,
          stake: autoTrade.stake,
          payout: payout,
          durationMs: durationMs,
          entryPrice: currentPrice,
          ...(autoTrade.contract === "over_under" || autoTrade.contract === "match_differ" ? { barrier: 5 } : {}),
        });
        
        console.log(`[Auto Trade] Placed trade #${autoTrade.tradesCount + 1}: ${trade.id} ${autoTrade.direction} @ ${trade.entryPrice}`);
        
        // Update trades count
        set((s) => ({
          autoTrade: {
            ...s.autoTrade,
            tradesCount: s.autoTrade.tradesCount + 1,
          }
        }));
        
      } catch (err) {
        console.error('[Auto Trade] Error placing trade:', err);
        toast.error('Failed to place auto trade');
        state.stopAutoTrade();
      }
    },

    handleAutoTradeSettlement: (trade: Trade) => {
      const state = get();
      const { autoTrade } = state;
      
      if (!autoTrade.isRunning) return;
      
      const pnl = trade.pnl || 0;
      const newTotalPnl = autoTrade.totalPnl + pnl;
      
      const wins = pnl > 0 ? autoTrade.wins + 1 : autoTrade.wins;
      const losses = pnl <= 0 ? autoTrade.losses + 1 : autoTrade.losses;
      
      set((s) => ({
        autoTrade: {
          ...s.autoTrade,
          totalPnl: newTotalPnl,
          wins,
          losses,
        }
      }));
      
      // Check if we hit stop loss
      if (newTotalPnl <= -autoTrade.stopLoss) {
        toast.error(`Auto Trading stopped: Stop Loss hit (${formatMoney(newTotalPnl, state.currency, state.fxRate)})`);
        state.stopAutoTrade();
        return;
      }
      
      // Check if we hit take profit
      if (newTotalPnl >= autoTrade.takeProfit) {
        toast.success(`Auto Trading finished: Take Profit hit (${formatMoney(newTotalPnl, state.currency, state.fxRate)}) 🎉`);
        state.stopAutoTrade();
        return;
      }
      
      // Place next trade
      setTimeout(() => {
        state.placeAutoTrade();
      }, 1000);
    },

    // ── Data Fetching ─────────────────────────────────────────────
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

    // ── WebSocket ──────────────────────────────────────────────────
    connectWebSocket: () => {
      if (wsInstance) {
        wsInstance.disconnect();
        wsInstance = null;
      }

      const token = getToken();
      wsInstance = new MarketWebSocket(token || undefined);
      
      wsInstance.on('tick', (data) => {
        if (data.price && data.symbol === get().volatility) {
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

      wsInstance.on('transaction_updated', (data) => {
        console.log('[WS] Transaction updated:', data);
        get().fetchBalances();
        if (data.status === 'completed') {
          if (data.type === 'deposit') {
            toast.success(`Deposit of $${data.amount_usd?.toFixed(2) || '0.00'} completed successfully!`);
          } else if (data.type === 'withdrawal') {
            toast.success(`Withdrawal of $${data.amount_usd?.toFixed(2) || '0.00'} completed!`);
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
        console.log(`[Store] WebSocket connected, subscribed to ${symbol}`);
      });
      
      wsInstance.on('disconnected', () => {
        set({ isConnected: false });
        console.log('[Store] WebSocket disconnected');
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

// ── Helper ──────────────────────────────────────────────────────

export function formatMoney(usd: number, currency: Currency, fxRate: number): string {
  const v = currency === "USD" ? usd : usd * fxRate;
  const symbol = currency === "USD" ? "$" : "KSh ";
  const formatted = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}${symbol}${formatted}`;
}