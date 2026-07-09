// src/routes/wallet.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApp, formatMoney } from "@/lib/store";
import { DepositModal } from "@/components/trade/DepositModal";
import { WithdrawalModal } from "@/components/trade/WithdrawalModal";
import { 
  getTransactions, 
  getWithdrawals, 
  type Transaction, 
  type WithdrawalRequest
} from "@/lib/api";
import { toast } from "sonner";
import { Loader2, RefreshCw, Filter, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/wallet")({
  head: () => ({ meta: [{ title: "G Wave — Wallet" }] }),
  component: WalletPage,
});

// Transaction type filter options
const TRANSACTION_TYPES = [
  { value: 'all', label: 'All Types' },
  { value: 'deposit', label: 'Deposits' },
  { value: 'withdrawal', label: 'Withdrawals' },
  { value: 'trade_win', label: 'Wins' },
  { value: 'trade_loss', label: 'Losses' },
  { value: 'stake', label: 'Stakes' },
];

// Transaction status filter options
const TRANSACTION_STATUSES = [
  { value: 'all', label: 'All Statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
];

function WalletPage() {
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalTransactions, setTotalTransactions] = useState(0);
  const [isPolling, setIsPolling] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPollingRef = useRef(false);
  
  const demoBalance = useApp((s) => s.demoBalance);
  const realBalance = useApp((s) => s.realBalance);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);
  const isAuthenticated = useApp((s) => s.isAuthenticated);
  const fetchBalances = useApp((s) => s.fetchBalances);
  const kycStatus = useApp((s) => s.kycStatus);

  const loadTransactions = useCallback(async () => {
    try {
      console.log('[Wallet] Loading transactions...');
      const type = filterType !== 'all' ? filterType : undefined;
      const status = filterStatus !== 'all' ? filterStatus : undefined;
      
      const response = await getTransactions(page, 20, type, status);
      if (response.success) {
        setTransactions(response.data.transactions);
        setTotalPages(response.data.totalPages);
        setTotalTransactions(response.data.total);
        
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
  }, [page, filterType, filterStatus]);

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

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setPage(newPage);
    }
  };

  const handleFilterChange = (type: string, status: string) => {
    setFilterType(type);
    setFilterStatus(status);
    setPage(1); // Reset to first page when filters change
  };

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

  const getTransactionStatusBadge = (status: string) => {
    switch (status) {
      case 'completed': return <Badge variant="default">Completed</Badge>;
      case 'pending': return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-500">Pending</Badge>;
      case 'failed': return <Badge variant="destructive">Failed</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
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

  const canWithdraw = kycStatus === 'approved' && realBalance > 0;

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
              <div className="mt-3 flex gap-2">
                {isAuthenticated ? (
                  <>
                    <Button 
                      className="bg-primary text-primary-foreground hover:bg-primary/90" 
                      onClick={() => setDepositOpen(true)}
                    >
                      Deposit
                    </Button>
                    <Button 
                      variant="outline"
                      onClick={() => setWithdrawOpen(true)}
                      disabled={!canWithdraw}
                      title={!canWithdraw ? (kycStatus !== 'approved' ? 'KYC required for withdrawals' : 'Insufficient balance') : ''}
                    >
                      Withdraw
                    </Button>
                  </>
                ) : (
                  <Button 
                    className="bg-primary text-primary-foreground hover:bg-primary/90" 
                    onClick={() => window.location.href = '/signup'}
                  >
                    Sign Up to Deposit
                  </Button>
                )}
              </div>
              {kycStatus !== 'approved' && realBalance > 0 && (
                <p className="mt-2 text-xs text-yellow-500">
                  ⚠️ KYC verification required for withdrawals
                </p>
              )}
            </Card>
          </div>

          <Card className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
              <h2 className="font-semibold">Transactions</h2>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {isPolling && (
                  <div className="flex items-center gap-2 text-xs text-yellow-500">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
                    </span>
                    Auto-refresh
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <Select value={filterType} onValueChange={(v) => handleFilterChange(v, filterStatus)}>
                    <SelectTrigger className="w-[130px]">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSACTION_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={filterStatus} onValueChange={(v) => handleFilterChange(filterType, v)}>
                    <SelectTrigger className="w-[130px]">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSACTION_STATUSES.map((status) => (
                        <SelectItem key={status.value} value={status.value}>
                          {status.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : transactions.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {filterType !== 'all' || filterStatus !== 'all' 
                  ? 'No transactions match the selected filters.' 
                  : 'No transactions yet.'}
              </div>
            ) : (
              <>
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
                        <div className="flex items-center justify-end gap-1">
                          {getTransactionStatusBadge(tx.status)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-4 mt-4 pt-4 border-t">
                    <div className="text-sm text-muted-foreground">
                      Showing {((page - 1) * 20) + 1} - {Math.min(page * 20, totalTransactions)} of {totalTransactions}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(page - 1)}
                        disabled={page === 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-sm">
                        Page {page} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(page + 1)}
                        disabled={page === totalPages}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
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

          <DepositModal open={depositOpen} onOpenChange={setDepositOpen} onDeposited={loadTransactions} />
          <WithdrawalModal open={withdrawOpen} onOpenChange={setWithdrawOpen} onWithdrawn={loadData} />
        </div>
      </AppShell>
    </AuthGuard>
  );
}