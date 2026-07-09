// src/components/trade/WithdrawalModal.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useApp, formatMoney } from "@/lib/store";

interface WithdrawalModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onWithdrawn?: () => void;
}

export function WithdrawalModal({ open, onOpenChange, onWithdrawn }: WithdrawalModalProps) {
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const realBalance = useApp((s) => s.realBalance);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);
  const account = useApp((s) => s.account);

  const handleWithdraw = async () => {
    const usdAmount = Number(amount);
    
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (usdAmount < 10) {
      toast.error("Minimum withdrawal is $10");
      return;
    }

    if (usdAmount > realBalance) {
      toast.error(`Insufficient balance. You have ${formatMoney(realBalance, currency, fxRate)}`);
      return;
    }

    setSubmitting(true);
    
    // Simulate withdrawal request
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    toast.success("Withdrawal request submitted for review!", {
      description: `$${usdAmount.toFixed(2)} will be processed within 1-2 business days.`,
    });
    
    setSubmitting(false);
    onOpenChange(false);
    setAmount("");
    onWithdrawn?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw Funds</DialogTitle>
          <DialogDescription>
            Request a withdrawal from your real account.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 pt-4">
          <div className="rounded-lg bg-muted p-3">
            <div className="text-sm text-muted-foreground">Available Balance</div>
            <div className="text-2xl font-bold">
              {formatMoney(realBalance, currency, fxRate)}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="withdraw-amount">Amount (USD)</Label>
            <Input
              id="withdraw-amount"
              type="number"
              min={10}
              step={1}
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Minimum withdrawal: $10 · Withdrawals are processed within 1-2 business days
            </p>
          </div>

          <div className="space-y-2">
            <Button
              onClick={handleWithdraw}
              disabled={submitting}
              className="w-full"
            >
              {submitting ? "Processing..." : `Withdraw ${amount ? `$${Number(amount).toFixed(2)}` : ''}`}
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full"
            >
              Cancel
            </Button>
          </div>

          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
            <p className="text-xs text-muted-foreground">
              ⚠️ Withdrawals require KYC verification. Please ensure your KYC is approved before requesting a withdrawal.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}