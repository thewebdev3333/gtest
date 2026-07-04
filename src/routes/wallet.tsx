// src/routes/wallet.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApp, formatMoney } from "@/lib/store";
import { DepositModal } from "@/components/trade/DepositModal";
import { 
  getTransactions, 
  getWithdrawals, 
  type Transaction, 
  type WithdrawalRequest
} from "@/lib/api";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/wallet")({
  head: () => ({ meta: [{ title: "G Wave — Wallet" }] }),
  component: WalletPage,
});

function WalletPage() {
  const [open, setOpen] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [isPolling, setIsPolling] = useState(false);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPollingRef = useRef(false);
  
  const demoBalance = useApp((s) => s.demoBalance);
  const realBalance = useApp((s) => s.realBalance);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);
  const isAuthenticated = useApp((s) => s.isAuthenticated);
  const fetchBalances = useApp((s) => s.fetchBalances);

  const loadTransactions = useCallback(async () => {
    try {
      console.log('[Wallet] Loading transactions...');
      const response = await getTransactions(page, 20);
      if (response.success) {
        setTransactions(response.data.transactions);
        const hasPendingTx = response.data.transactions.some(tx => tx.status === 'pending');
        console.log('[Wallet] Has pending transactions:', hasPendingTx);
        
        if (hasPendingTx && !isPollingRef.current) {
          startPolling();
        } else if (!hasPendingTx && isPollingRef.current) {
          stopPolling();
        }
      }
    } catch (err) {
      console.error('Failed to load transactions:', err);
    }
  }, [page]);

  const loadWithdrawals = useCallback(async () => {
    try {
      const response = await getWithdrawals();
      if (response.success) {
        setWithdrawals(response.data.withdrawals);
      }
    } catch (err) {
      console.error('Failed to load withdrawals:', err);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchBalances(),
        loadTransactions(),
        loadWithdrawals(),
      ]);
    } catch (err) {
      console.error('Failed to load wallet data:', err);
    } finally {
      setLoading(false);
    }
  }, [fetchBalances, loadTransactions, loadWithdrawals]);

  const startPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    
    console.log('[Wallet] Starting polling (every 3s)');
    isPollingRef.current = true;
    setIsPolling(true);
    
    pollingIntervalRef.current = setInterval(() => {
      loadTransactions();
      fetchBalances();
    }, 3000);
  }, [loadTransactions, fetchBalances]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      console.log('[Wallet] Stopping polling');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    isPollingRef.current = false;
    setIsPolling(false);
  }, []);

  const handleRefresh = useCallback(() => {
    loadData();
    toast.info('Refreshing...');
  }, [loadData]);

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      isPollingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadData();
    } else {
      if (isPollingRef.current) {
        stopPolling();
      }
    }
  }, [isAuthenticated, loadData, stopPolling]);

  const getTransactionStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-primary';
      case 'pending': return 'text-yellow-500';
      case 'failed': return 'text-destructive';
      default: return 'text-muted-foreground';
    }
  };

  const getTransactionLabel = (type: string) => {
    switch (type) {
      case 'deposit': return 'Deposit';
      case 'withdrawal': return 'Withdrawal';
      case 'trade_win': return 'Trade Win';
      case 'trade_loss': return 'Trade Loss';
      case 'stake': return 'Stake';
      default: return type;
    }
  };

  return (
    <AuthGuard>
      <AppShell>
        <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Wallet</h1>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleRefresh}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
          
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-5">
              <div className="text-sm text-muted-foreground">Demo Account</div>
              <div className="mt-1 text-3xl font-bold">{formatMoney(demoBalance, currency, fxRate)}</div>
              <div className="mt-3 text-xs text-muted-foreground">Practice funds, reset anytime.</div>
            </Card>
            <Card className="p-5">
              <div className="text-sm text-muted-foreground">Real Account</div>
              <div className="mt-1 text-3xl font-bold">{formatMoney(realBalance, currency, fxRate)}</div>
              {isAuthenticated ? (
                <Button 
                  className="mt-3 bg-primary text-primary-foreground hover:bg-primary/90" 
                  onClick={() => setOpen(true)}
                >
                  Deposit
                </Button>
              ) : (
                <Button 
                  className="mt-3 bg-primary text-primary-foreground hover:bg-primary/90" 
                  onClick={() => window.location.href = '/signup'}
                >
                  Sign Up to Deposit
                </Button>
              )}
            </Card>
          </div>

          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Recent Transactions</h2>
              <div className="flex items-center gap-3">
                {isPolling && (
                  <div className="flex items-center gap-2 text-xs text-yellow-500">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
                    </span>
                    Auto-refresh
                  </div>
                )}
              </div>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : transactions.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {transactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-3 text-sm">
                    <div>
                      <div className="font-medium">{getTransactionLabel(tx.type)}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(tx.created_at).toLocaleString()}
                        {tx.reference && ` · ${tx.reference.slice(0, 8)}`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={tx.type === 'deposit' || tx.type === 'trade_win' ? 'text-primary' : tx.type === 'trade_loss' || tx.type === 'stake' ? 'text-destructive' : ''}>
                        {tx.type === 'deposit' || tx.type === 'trade_win' ? '+' : tx.type === 'trade_loss' || tx.type === 'stake' ? '-' : ''}
                        {formatMoney(parseFloat(tx.amount_usd), currency, fxRate)}
                      </div>
                      <div className={`text-xs ${getTransactionStatusColor(tx.status)}`}>
                        {tx.status}
                        {tx.status === 'pending' && (
                          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {withdrawals.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 font-semibold">Withdrawal Requests</h2>
              <div className="divide-y divide-border">
                {withdrawals.map((w) => (
                  <div key={w.id} className="flex items-center justify-between py-3 text-sm">
                    <div>
                      <div className="font-medium">Withdrawal</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(w.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div>{formatMoney(parseFloat(w.amount_usd), currency, fxRate)}</div>
                      <div className={`text-xs ${
                        w.status === 'completed' ? 'text-primary' : 
                        w.status === 'pending_review' ? 'text-yellow-500' : 
                        w.status === 'rejected' || w.status === 'failed' ? 'text-destructive' :
                        'text-muted-foreground'
                      }`}>
                        {w.status.replace('_', ' ')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <DepositModal open={open} onOpenChange={setOpen} onDeposited={loadTransactions} />
        </div>
      </AppShell>
    </AuthGuard>
  );
}