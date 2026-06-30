// wallet.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApp, formatMoney } from "@/lib/store";
import { DepositModal } from "@/components/trade/DepositModal";
import { 
  getTransactions, 
  getWithdrawals, 
  checkPendingTransactions,
  type Transaction, 
  type WithdrawalRequest,
  type PendingTransactionStatus
} from "@/lib/api";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

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
  const [hasPending, setHasPending] = useState(false);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
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
        // Check if there are any pending transactions
        const hasPendingTx = response.data.transactions.some(tx => tx.status === 'pending');
        setHasPending(hasPendingTx);
        console.log('[Wallet] Has pending transactions:', hasPendingTx);
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

  // Poll for pending transaction status
  const pollPendingTransactions = useCallback(async () => {
    if (!isAuthenticated || !hasPending) {
      return;
    }

    try {
      console.log('[Wallet] Polling for pending transactions...');
      const response = await checkPendingTransactions();
      
      if (response.success && response.data.transactions.length > 0) {
        // Update the transactions in the list
        setTransactions(prev => 
          prev.map(tx => {
            const updated = response.data.transactions.find((t: PendingTransactionStatus) => t.id === tx.id);
            if (updated && updated.status !== tx.status) {
              console.log(`[Wallet] Transaction ${tx.id} status changed: ${tx.status} -> ${updated.status}`);
              
              // Show toast notification
              if (updated.status === 'completed') {
                if (tx.type === 'deposit') {
                  toast.success(`Deposit of $${parseFloat(tx.amount_usd).toFixed(2)} completed!`);
                } else if (tx.type === 'withdrawal') {
                  toast.success(`Withdrawal of $${parseFloat(tx.amount_usd).toFixed(2)} completed!`);
                }
              } else if (updated.status === 'failed') {
                if (tx.type === 'deposit') {
                  toast.error('Deposit failed. Please try again.');
                } else if (tx.type === 'withdrawal') {
                  toast.error('Withdrawal failed. Please contact support.');
                }
              }
              
              return { ...tx, status: updated.status };
            }
            return tx;
          })
        );
        
        // Refresh balances if any transaction was updated
        if (response.data.transactions.some((t: PendingTransactionStatus) => t.status !== 'pending')) {
          fetchBalances();
        }
        
        // Check if there are still pending transactions
        const stillPending = transactions.some(tx => tx.status === 'pending');
        setHasPending(stillPending);
        
        // If no more pending, stop polling
        if (!stillPending && pollingIntervalRef.current) {
          console.log('[Wallet] No pending transactions, stopping polling');
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error('[Wallet] Failed to poll pending transactions:', err);
    }
  }, [isAuthenticated, hasPending, transactions, fetchBalances]);

  // Start/stop polling based on pending transactions
  useEffect(() => {
    if (!isAuthenticated) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    if (hasPending) {
      console.log('[Wallet] Starting polling for pending transactions');
      // Poll immediately
      pollPendingTransactions();
      // Then poll every 3 seconds
      pollingIntervalRef.current = setInterval(pollPendingTransactions, 3000);
    } else {
      if (pollingIntervalRef.current) {
        console.log('[Wallet] No pending transactions, stopping polling');
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    }

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [isAuthenticated, hasPending, pollPendingTransactions]);

  // Initial load
  useEffect(() => {
    if (isAuthenticated) {
      loadData();
    }
  }, [isAuthenticated, loadData]);

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
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
        <h1 className="text-2xl font-bold">Wallet</h1>
        
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
            {hasPending && (
              <div className="flex items-center gap-2 text-xs text-yellow-500">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
                </span>
                Checking for updates...
              </div>
            )}
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

        <DepositModal open={open} onOpenChange={setOpen} />
      </div>
    </AppShell>
  );
}