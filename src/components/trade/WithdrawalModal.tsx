// src/components/trade/WithdrawalModal.tsx
import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useApp, formatMoney } from "@/lib/store";
import { withdrawMpesa, requestInfluencerWithdrawal, ApiError } from "@/lib/api";

interface WithdrawalModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onWithdrawn?: () => void;
}

export function WithdrawalModal({ open, onOpenChange, onWithdrawn }: WithdrawalModalProps) {
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const realBalance = useApp((s) => s.realBalance);
  const currency = useApp((s) => s.currency);
  const fxRate = useApp((s) => s.fxRate);
  const account = useApp((s) => s.account);
  const fetchBalances = useApp((s) => s.fetchBalances);
  const role = useApp((s) => s.role);
  const isInfluencer = role === "influencer";

  // Whatever's already in the store might be stale (or never fetched at
  // all in this session), and the "Insufficient balance" check and the
  // displayed "Available Balance" both rely on it — so pull a fresh
  // number every time the modal is opened rather than trusting whatever
  // happens to already be in state.
  useEffect(() => {
    if (open) {
      fetchBalances();
    }
  }, [open]);

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

    const cleanedPhone = phone.replace(/\s/g, "");
    const validPhone = /^(07\d{8}|01\d{8}|2547\d{8}|2541\d{8}|7\d{8}|1\d{8})$/.test(cleanedPhone);
    if (!validPhone) {
      toast.error("Enter a valid M-Pesa number, e.g. 07XXXXXXXX or 01XXXXXXXX");
      return;
    }

    setSubmitting(true);

    try {
      if (isInfluencer) {
        // Same UI and validation as everyone else, but influencer accounts
        // route to the mock withdrawal flow (see influencer.js) instead of
        // the real M-Pesa endpoint. The phone number is collected for a
        // consistent demo experience but isn't part of this endpoint's
        // request — the mock flow only needs the amount.
        await requestInfluencerWithdrawal(usdAmount);
      } else {
        // Each submission gets its own key so a retried/duplicated click can't
        // create two withdrawal requests, but it's scoped to this call only —
        // never reused across other actions (e.g. a deposit).
        const idempotencyKey = crypto.randomUUID();
        await withdrawMpesa(cleanedPhone, usdAmount, idempotencyKey);
      }

      toast.success("Withdrawal request submitted!");

      // The balance was already deducted server-side the moment the request
      // was accepted, so refresh now instead of waiting for the eventual
      // "completed" websocket event.
      await fetchBalances();

      setAmount("");
      setPhone("");
      onOpenChange(false);
      onWithdrawn?.();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "KYC_REQUIRED") {
          toast.error("KYC verification required for withdrawals over $100.");
        } else if (err.code === "PENDING_WITHDRAWAL") {
          toast.error("You already have a withdrawal request pending review.");
        } else if (err.code === "RATE_LIMITED") {
          toast.error("Maximum 256 withdrawals per day.");
        } else if (err.code === "INSUFFICIENT_BALANCE" || err.code === "NOT_FOUND") {
          toast.error("Insufficient balance.");
        } else {
          toast.error(err.message || "Withdrawal request failed. Please try again.");
        }
      } else {
        toast.error("Withdrawal request failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
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
            <Label htmlFor="withdraw-phone">M-Pesa Phone Number</Label>
            <Input
              id="withdraw-phone"
              type="tel"
              placeholder="07XXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
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