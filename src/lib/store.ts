// src/lib/store.ts
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
  mapSymbolToFrontend,
  settleTrade,
  ApiError,
  type Position,
  type Transaction,
  type WithdrawalRequest,
} from './api'
import type { AIDecision } from './ai-engine';

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
  durationMs: number;
  durationUnit: DurationUnit;
  durationVal: number;
  barrier?: number;
  isRunning: boolean;
  totalPnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
  startedAt: number | null;
  aiDecision?: AIDecision | null;
  currentContractId?: string | null;
}

export interface AutoTradeResult {
  reason: 'take_profit' | 'stop_loss' | 'max_trades' | 'manual_stop' | 'insufficient_balance' | 'error';
  totalPnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
  startedAt: number | null;
  stoppedAt: number;
  direction?: string;
  contract?: string;
  stopLoss?: number;
  takeProfit?: number;
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
  setTrades: (trades: Trade[]) => void;
  openTrade: (t: Omit<Trade, "id" | "status" | "entryAt" | "expiresAt"> & { entryAt?: number }) => Trade;
  settleTrade: (id: string, exitPrice: number) => Promise<Trade | undefined>;
  crosshairEnabled: boolean;
  toggleCrosshair: () => void;
  isLoading: boolean;
  error: string | null;
  ws: MarketWebSocket | null;
  isConnected: boolean;
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected';
  autoTrade: AutoTradeConfig;
  startAutoTrade: (config: Partial<AutoTradeConfig>) => void;
  stopAutoTrade: (skipModal?: boolean) => void;
  placeAutoTrade: () => Promise<void>;
  handleAutoTradeSettlement: (trade: Trade) => void;
  autoTradeResult: {
    show: boolean;
    result: AutoTradeResult | null;
  };
  showAutoTradeResult: (result: AutoTradeResult) => void;
  hideAutoTradeResult: () => void;
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

const initialAutoTrade: AutoTradeConfig = {
  enabled: false,
  direction: "rise",
  contract: "rise_fall",
  volatility: "v100_1s",
  stake: 5,
  stopLoss: 20,
  takeProfit: 10,
  maxTrades: undefined,
  durationMs: 10000,
  durationUnit: "ticks",
  durationVal: 10,
  barrier: undefined,
  isRunning: false,
  totalPnl: 0,
  tradesCount: 0,
  wins: 0,
  losses: 0,
  startedAt: null,
  aiDecision: null,
  currentContractId: null,
};

const initialAutoTradeResult = {
  show: false,
  result: null,
};

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

    price: 204.33,
    prevPrice: 204.33,
    setPrice: (p) => set((s) => ({ price: p, prevPrice: s.price })),
    resetPrice: (p) => set({ price: p, prevPrice: p }),

    trades: [],
    setTrades: (trades) => set({ trades }),

    openTrade: (t, realId?: string) => {
      const entryAt = t.entryAt ?? Date.now();
      const trade: Trade = {
        ...t,
        id: realId || Math.random().toString(36).slice(2),
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

    // ✅ FIXED: settleTrade with proper error handling
    settleTrade: async (id, exitPrice) => {
      const t = get().trades.find((x) => x.id === id);
      if (!t || t.status !== "open") return;

      try {
        const accountType = get().account;
        const response = await settleTrade(id, exitPrice, accountType);

        if (response.success) {
          const { outcome, pnl, newBalance } = response.data;
          const won = outcome === 'win';
          const balKey = get().account === "demo" ? "demoBalance" : "realBalance";

          const updatedTrade: Trade = { ...t, status: won ? "won" : "lost", exitPrice, pnl };

          set((s) => ({
            trades: s.trades.map((x) => (x.id === id ? updatedTrade : x)),
            [balKey]: newBalance,
          }) as Partial<AppState>);
          savePrefs(get());

          const autoTrade = get().autoTrade;
          if (autoTrade.isRunning) {
            get().handleAutoTradeSettlement(updatedTrade);
          }

          return updatedTrade;
        }
      } catch (err) {
        // ✅ NEW: distinguish "backend already handled this" from "backend is unreachable"
        if (err instanceof ApiError) {
          if (err.code === 'INVALID_STATE' || err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN') {
            // Contract was already settled (most likely by the backend's own
            // tick-engine, or by a duplicate call). Do NOT re-simulate or
            // re-credit — the WS `contract_settled` event / next syncTrades()
            // call will reconcile local state with the true outcome.
            console.warn(`[settleTrade] Skipping local fallback for ${id}: backend responded ${err.code}.`);
            return undefined;
          }
          // Some other real API error (validation, unexpected 4xx/5xx) — surface it
          console.error('[settleTrade] Backend rejected settlement:', err);
          toast.error(err.message || 'Failed to settle trade.');
          return undefined;
        }

        // Not an ApiError → genuine connectivity failure (fetch threw, DNS
        // failure, response wasn't valid JSON, etc). Safe to fall back locally.
        console.warn('[settleTrade] Backend unreachable, using local fallback:', err);

        // ── FALLBACK: Use local simulation (only reached on real outages now) ──
        let won = false;
        // ✅ FIXED: last digit of integer part, matching backend's resolveOutcome
        const lastDigit = Math.floor(exitPrice) % 10;
        switch (t.direction) {
          case "rise": won = exitPrice > t.entryPrice; break;
          case "fall": won = exitPrice < t.entryPrice; break;
          case "over": won = lastDigit > (t.barrier ?? 5); break;
          case "under": won = lastDigit < (t.barrier ?? 5); break;
          case "match": won = lastDigit === (t.barrier ?? 0); break;
          case "differ": won = lastDigit !== (t.barrier ?? 0); break;
          case "even": won = lastDigit % 2 === 0; break;
          case "odd": won = lastDigit % 2 === 1; break;
        }

        const pnl = won ? t.payout - t.stake : -t.stake;
        const credit = won ? t.payout : 0;
        const balKey = get().account === "demo" ? "demoBalance" : "realBalance";

        const updatedTrade: Trade = { ...t, status: won ? "won" : "lost", exitPrice, pnl };

        set((s) => ({
          trades: s.trades.map((x) => (x.id === id ? updatedTrade : x)),
          [balKey]: (s[balKey] as number) + credit,
        }) as Partial<AppState>);
        savePrefs(get());

        const autoTrade = get().autoTrade;
        if (autoTrade.isRunning) {
          get().handleAutoTradeSettlement(updatedTrade);
        }

        toast.info('Trade settled locally (backend not available)');
        return updatedTrade;
      }
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

    autoTrade: initialAutoTrade,
    autoTradeResult: initialAutoTradeResult,

    showAutoTradeResult: (result) => {
      set({ 
        autoTradeResult: { 
          show: true, 
          result: { ...result, stoppedAt: Date.now() } 
        } 
      });
    },

    hideAutoTradeResult: () => {
      set({ autoTradeResult: { show: false, result: null } });
    },

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
          durationMs: config.durationMs || current.durationMs,
          durationUnit: config.durationUnit || current.durationUnit,
          durationVal: config.durationVal || current.durationVal,
          barrier: config.barrier !== undefined ? config.barrier : current.barrier,
          aiDecision: config.aiDecision || null,
          currentContractId: null,
        }
      });
      
      toast.success("Auto Trading started! 🚀", {
        description: `Direction: ${config.direction || current.direction} · Stop Loss: $${config.stopLoss || current.stopLoss} · Take Profit: $${config.takeProfit || current.takeProfit}`
      });
      
      setTimeout(() => {
        get().placeAutoTrade();
      }, 500);
    },

    stopAutoTrade: (skipModal = false) => {
      const current = get().autoTrade;
      if (!current.isRunning) return;
      
      const stoppedAt = Date.now();
      
      if (!skipModal) {
        get().showAutoTradeResult({
          reason: 'manual_stop',
          totalPnl: current.totalPnl,
          tradesCount: current.tradesCount,
          wins: current.wins,
          losses: current.losses,
          startedAt: current.startedAt,
          stoppedAt: stoppedAt,
          direction: current.direction,
          contract: current.contract,
          stopLoss: current.stopLoss,
          takeProfit: current.takeProfit,
        });
      }
      
      set({
        autoTrade: {
          ...current,
          isRunning: false,
          enabled: false,
          currentContractId: null,
        }
      });
      
      const state = get();
      toast.info(`Auto Trading stopped`, {
        description: `Trades: ${current.tradesCount} · P&L: ${formatMoney(current.totalPnl, state.currency, state.fxRate)}`
      });
    },

    placeAutoTrade: async () => {
      const state = get();
      const { autoTrade } = state;
      
      if (!autoTrade.isRunning) {
        console.log('[Auto Trade] Not running, skipping');
        return;
      }
      
      // Check stop loss
      if (autoTrade.totalPnl <= -autoTrade.stopLoss) {
        const stoppedAt = Date.now();
        get().showAutoTradeResult({
          reason: 'stop_loss',
          totalPnl: autoTrade.totalPnl,
          tradesCount: autoTrade.tradesCount,
          wins: autoTrade.wins,
          losses: autoTrade.losses,
          startedAt: autoTrade.startedAt,
          stoppedAt: stoppedAt,
          direction: autoTrade.direction,
          contract: autoTrade.contract,
          stopLoss: autoTrade.stopLoss,
          takeProfit: autoTrade.takeProfit,
        });
        state.stopAutoTrade(true);
        return;
      }
      
      // Check take profit
      if (autoTrade.totalPnl >= autoTrade.takeProfit) {
        const stoppedAt = Date.now();
        get().showAutoTradeResult({
          reason: 'take_profit',
          totalPnl: autoTrade.totalPnl,
          tradesCount: autoTrade.tradesCount,
          wins: autoTrade.wins,
          losses: autoTrade.losses,
          startedAt: autoTrade.startedAt,
          stoppedAt: stoppedAt,
          direction: autoTrade.direction,
          contract: autoTrade.contract,
          stopLoss: autoTrade.stopLoss,
          takeProfit: autoTrade.takeProfit,
        });
        state.stopAutoTrade(true);
        return;
      }
      
      // Check max trades
      if (autoTrade.maxTrades && autoTrade.tradesCount >= autoTrade.maxTrades) {
        const stoppedAt = Date.now();
        get().showAutoTradeResult({
          reason: 'max_trades',
          totalPnl: autoTrade.totalPnl,
          tradesCount: autoTrade.tradesCount,
          wins: autoTrade.wins,
          losses: autoTrade.losses,
          startedAt: autoTrade.startedAt,
          stoppedAt: stoppedAt,
          direction: autoTrade.direction,
          contract: autoTrade.contract,
          stopLoss: autoTrade.stopLoss,
          takeProfit: autoTrade.takeProfit,
        });
        state.stopAutoTrade(true);
        return;
      }
      
      // ── CALL THE REAL BACKEND API ──────────────────────────────────
      const payout = autoTrade.stake * PAYOUT_MULTIPLIER[autoTrade.contract];
      const durationTicks = Math.max(2, Math.round(autoTrade.durationMs / 1000));
      
      try {
        const response = await placeTrade({
          accountType: state.account,
          symbol: autoTrade.volatility,
          contractType: autoTrade.contract,
          direction: autoTrade.direction,
          selectedDigit: autoTrade.barrier,
          stake: autoTrade.stake,
          durationTicks: Math.min(durationTicks, 3600),
        });

        if (response.success) {
          console.log(`[Auto Trade] Placed trade #${autoTrade.tradesCount + 1}: ${response.data.contractId} ${autoTrade.direction} @ ${response.data.entryPrice}`);
          
          const contractId = response.data.contractId;
          
          // Add to local trades list with the REAL contract ID
          const trade: Trade = {
            id: contractId,
            contract: autoTrade.contract,
            direction: autoTrade.direction,
            volatility: autoTrade.volatility,
            stake: autoTrade.stake,
            payout: payout,
            durationMs: autoTrade.durationMs,
            entryPrice: response.data.entryPrice,
            entryAt: Date.now(),
            expiresAt: Date.now() + autoTrade.durationMs,
            barrier: autoTrade.barrier,
            status: "open",
            exitPrice: undefined,
            pnl: undefined,
          };
          
          set((s) => ({
            trades: [trade, ...s.trades],
            autoTrade: {
              ...s.autoTrade,
              tradesCount: s.autoTrade.tradesCount + 1,
              currentContractId: contractId,
            }
          }));
          
          // Refresh balances to get updated balance from backend
          await get().fetchBalances();
          
        } else {
          console.error('[Auto Trade] Failed to place trade:', response);
          const stoppedAt = Date.now();
          get().showAutoTradeResult({
            reason: 'insufficient_balance',
            totalPnl: autoTrade.totalPnl,
            tradesCount: autoTrade.tradesCount,
            wins: autoTrade.wins,
            losses: autoTrade.losses,
            startedAt: autoTrade.startedAt,
            stoppedAt: stoppedAt,
            direction: autoTrade.direction,
            contract: autoTrade.contract,
            stopLoss: autoTrade.stopLoss,
            takeProfit: autoTrade.takeProfit,
          });
          state.stopAutoTrade(true);
        }
        
      } catch (err: any) {
        console.error('[Auto Trade] Error placing trade:', err);
        
        if (err.message?.includes('INSUFFICIENT_BALANCE') || err.message?.includes('Insufficient balance')) {
          const stoppedAt = Date.now();
          get().showAutoTradeResult({
            reason: 'insufficient_balance',
            totalPnl: autoTrade.totalPnl,
            tradesCount: autoTrade.tradesCount,
            wins: autoTrade.wins,
            losses: autoTrade.losses,
            startedAt: autoTrade.startedAt,
            stoppedAt: stoppedAt,
            direction: autoTrade.direction,
            contract: autoTrade.contract,
            stopLoss: autoTrade.stopLoss,
            takeProfit: autoTrade.takeProfit,
          });
          state.stopAutoTrade(true);
        } else {
          toast.error('Failed to place auto trade: ' + err.message);
        }
      }
    },

    handleAutoTradeSettlement: (trade: Trade) => {
      const state = get();
      const { autoTrade } = state;
      
      if (!autoTrade.isRunning) return;
      
      const pnl = trade.pnl ?? 0;
      const newTotalPnl = autoTrade.totalPnl + pnl;
      
      const wins = pnl > 0 ? autoTrade.wins + 1 : autoTrade.wins;
      const losses = pnl <= 0 ? autoTrade.losses + 1 : autoTrade.losses;
      
      console.log(`[Auto Trade] Trade settled: ${trade.id} | P&L: ${pnl} | Total P&L: ${newTotalPnl} | Win: ${pnl > 0}`);
      
      set((s) => ({
        autoTrade: {
          ...s.autoTrade,
          totalPnl: newTotalPnl,
          wins,
          losses,
          currentContractId: null,
        }
      }));
      
      // Refresh balances after settlement
      get().fetchBalances();
      
      // Check stop loss
      if (newTotalPnl <= -autoTrade.stopLoss) {
        const stoppedAt = Date.now();
        get().showAutoTradeResult({
          reason: 'stop_loss',
          totalPnl: newTotalPnl,
          tradesCount: autoTrade.tradesCount,
          wins: wins,
          losses: losses,
          startedAt: autoTrade.startedAt,
          stoppedAt: stoppedAt,
          direction: autoTrade.direction,
          contract: autoTrade.contract,
          stopLoss: autoTrade.stopLoss,
          takeProfit: autoTrade.takeProfit,
        });
        state.stopAutoTrade(true);
        return;
      }
      
      // Check take profit
      if (newTotalPnl >= autoTrade.takeProfit) {
        const stoppedAt = Date.now();
        get().showAutoTradeResult({
          reason: 'take_profit',
          totalPnl: newTotalPnl,
          tradesCount: autoTrade.tradesCount,
          wins: wins,
          losses: losses,
          startedAt: autoTrade.startedAt,
          stoppedAt: stoppedAt,
          direction: autoTrade.direction,
          contract: autoTrade.contract,
          stopLoss: autoTrade.stopLoss,
          takeProfit: autoTrade.takeProfit,
        });
        state.stopAutoTrade(true);
        return;
      }
      
      // Place next trade
      setTimeout(() => {
        state.placeAutoTrade();
      }, 1000);
    },

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

    // ✅ FIXED: syncTrades now converts backend symbol to frontend format
    syncTrades: async () => {
      try {
        const accountType = get().account;
        const response = await getOpenPositions(accountType);
        if (response.success) {
          const trades = response.data.positions.map((p: Position) => ({
            id: p.id,
            contract: p.contract_type as any,
            direction: p.direction as any,
            volatility: mapSymbolToFrontend(p.symbol) as any, // ✅ CHANGED
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
        if (data.price && data.symbol === get().volatility) {
          set((s) => ({
            price: data.price,
            prevPrice: s.price,
          }));
        }
      });
      
      wsInstance.on('contract_settled', (data) => {
        console.log('[WS] Contract settled:', data);
        
        // Sync trades and balances from the backend
        get().syncTrades();
        get().fetchBalances();
        
        // If auto trade is running, check if this is our auto trade contract
        const autoTrade = get().autoTrade;
        if (autoTrade.isRunning && data.contractId === autoTrade.currentContractId) {
          // Find the trade in our local list
          const trade = get().trades.find(t => t.id === data.contractId);
          if (trade && trade.status === 'open') {
            // Update the trade with the settlement data
            const updatedTrade: Trade = {
              ...trade,
              status: data.outcome === 'win' ? 'won' : 'lost',
              exitPrice: data.exitPrice,
              pnl: data.pnl,
            };
            
            // Update trades list
            set((s) => ({
              trades: s.trades.map((t) => t.id === data.contractId ? updatedTrade : t),
            }));
            
            // Let auto trade handle the settlement
            get().handleAutoTradeSettlement(updatedTrade);
          }
        }
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

export function formatMoney(usd: number, currency: Currency, fxRate: number): string {
  const v = currency === "USD" ? usd : usd * fxRate;
  const symbol = currency === "USD" ? "$" : "KSh ";
  const formatted = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}${symbol}${formatted}`;
}