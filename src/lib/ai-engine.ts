// src/lib/ai-engine.ts
import { type VolatilityId, type Direction, type ContractType, VOLATILITIES, CONTRACTS, PAYOUT_MULTIPLIER, NEGATIVE_DIRECTIONS } from './store';

export interface MarketData {
  symbol: VolatilityId;
  price: number;
  prevPrice: number;
  change: number;
  changePct: number;
  volatility: number; // sigma
  tickCount?: number;
  lastDigit: number; // Last digit of current price
}

export interface AIDecision {
  symbol: VolatilityId;
  contract: ContractType;
  direction: Direction;
  barrier?: number; // For Over/Under and Match/Differ
  confidence: number; // 0-100
  score: number; // 0-100 raw score
  expectedValue: number; // Expected profit per $1 staked
  winRate: number; // Estimated win rate 0-1
  reasoning: {
    market: string;
    contract: string;
    direction: string;
    barrier?: string;
    volatility: string;
    trend: string;
    reversion: string;
    winRate: string;
    risk: string;
    expectedValue: string;
  };
  suggestedStake: number;
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
  timestamp: number;
}

export interface AIPerformance {
  totalDecisions: number;
  wins: number;
  losses: number;
  totalPnl: number;
  symbolPerformance: Record<VolatilityId, { wins: number; losses: number; pnl: number; trades: number }>;
  contractPerformance: Record<ContractType, { wins: number; losses: number; pnl: number; trades: number }>;
}

interface TradeHistory {
  symbol: VolatilityId;
  contract: ContractType;
  direction: Direction;
  barrier?: number;
  outcome: 'win' | 'loss';
  pnl: number;
}

// ── Contract Configuration ────────────────────────────────────────

interface ContractOption {
  contract: ContractType;
  direction: Direction;
  barrier?: number;
  label: string;
  winRate: number; // Estimated win rate based on market conditions
  expectedValue: number; // EV = winRate * payout - (1-winRate) * stake
  payoutMultiplier: number;
}

// ── AI Engine ──────────────────────────────────────────────────────

export class AIEngine {
  private tradeHistory: TradeHistory[] = [];
  private maxHistorySize = 200;
  private decisions: AIDecision[] = [];
  private lastDecision: AIDecision | null = null;
  private performance: AIPerformance;

  constructor(initialHistory?: TradeHistory[]) {
    this.performance = {
      totalDecisions: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      symbolPerformance: {
        v100_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v50_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v25_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
      contractPerformance: {
        rise_fall: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        over_under: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        match_differ: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        even_odd: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
    };

    if (initialHistory) {
      this.tradeHistory = initialHistory.slice(-this.maxHistorySize);
      this.updatePerformanceFromHistory();
    }
  }

  // ── Public Methods ──────────────────────────────────────────────

  /**
   * Evaluate ALL markets and ALL contracts, return the best combination
   */
  public evaluate(markets: MarketData[], balance: number, riskTolerance: 'conservative' | 'moderate' | 'aggressive' = 'moderate'): AIDecision | null {
    if (markets.length === 0) return null;

    // Generate all possible trade combinations
    const allOptions: (ContractOption & { market: MarketData; score: number })[] = [];

    for (const market of markets) {
      // Generate options for each contract type
      const options = this.generateContractOptions(market);
      for (const option of options) {
        // Calculate score for this combination
        const score = this.calculateCombinationScore(market, option, riskTolerance);
        allOptions.push({
          ...option,
          market,
          score,
        });
      }
    }

    // Sort by score (highest first)
    const sorted = allOptions.sort((a, b) => b.score - a.score);

    // Get the best option
    const best = sorted[0];
    if (!best || best.score < 30) {
      return null;
    }

    // Apply risk tolerance threshold
    const threshold = riskTolerance === 'conservative' ? 65 : riskTolerance === 'moderate' ? 50 : 35;
    if (best.score < threshold) {
      return null;
    }

    // Build the decision
    const confidence = Math.min(95, best.score);
    const decision = this.buildDecision(best, balance, confidence);

    this.decisions.push(decision);
    this.lastDecision = decision;

    return decision;
  }

  /**
   * Generate all possible contract options for a market
   */
  private generateContractOptions(market: MarketData): ContractOption[] {
    const options: ContractOption[] = [];
    const lastDigit = market.lastDigit;

    // ── Rise/Fall ──────────────────────────────────────────────────
    const trendScore = this.calculateTrendScore(market);
    const direction = trendScore > 50 ? 'rise' : 'fall';
    const rfPayout = PAYOUT_MULTIPLIER.rise_fall;
    const rfWinRate = this.estimateRiseFallWinRate(market);
    options.push({
      contract: 'rise_fall',
      direction: direction as Direction,
      barrier: undefined,
      label: `${direction.toUpperCase()}`,
      winRate: rfWinRate,
      expectedValue: rfWinRate * rfPayout - (1 - rfWinRate),
      payoutMultiplier: rfPayout,
    });

    // ── Over/Under ─────────────────────────────────────────────────
    // Over 0: wins if lastDigit > 0 (90% win rate)
    // Under 9: wins if lastDigit < 9 (90% win rate)
    const ouPayout = PAYOUT_MULTIPLIER.over_under;
    
    // Over 0 — wins on digits 1-9 (90%)
    options.push({
      contract: 'over_under',
      direction: 'over' as Direction,
      barrier: 0,
      label: 'Over 0',
      winRate: 0.9,
      expectedValue: 0.9 * ouPayout - 0.1,
      payoutMultiplier: ouPayout,
    });

    // Under 9 — wins on digits 0-8 (90%)
    options.push({
      contract: 'over_under',
      direction: 'under' as Direction,
      barrier: 9,
      label: 'Under 9',
      winRate: 0.9,
      expectedValue: 0.9 * ouPayout - 0.1,
      payoutMultiplier: ouPayout,
    });

    // Over 5 — wins if lastDigit > 5 (40%)
    options.push({
      contract: 'over_under',
      direction: 'over' as Direction,
      barrier: 5,
      label: 'Over 5',
      winRate: 0.4,
      expectedValue: 0.4 * ouPayout - 0.6,
      payoutMultiplier: ouPayout,
    });

    // Under 5 — wins if lastDigit < 5 (50%)
    options.push({
      contract: 'over_under',
      direction: 'under' as Direction,
      barrier: 5,
      label: 'Under 5',
      winRate: 0.5,
      expectedValue: 0.5 * ouPayout - 0.5,
      payoutMultiplier: ouPayout,
    });

    // ── Match/Differ ──────────────────────────────────────────────
    const mdPayout = PAYOUT_MULTIPLIER.match_differ;
    
    // Match each digit 0-9 (10% each)
    for (let digit = 0; digit <= 9; digit++) {
      options.push({
        contract: 'match_differ',
        direction: 'match' as Direction,
        barrier: digit,
        label: `Match ${digit}`,
        winRate: 0.1,
        expectedValue: 0.1 * mdPayout - 0.9,
        payoutMultiplier: mdPayout,
      });
    }

    // Differ each digit 0-9 (90% each)
    for (let digit = 0; digit <= 9; digit++) {
      options.push({
        contract: 'match_differ',
        direction: 'differ' as Direction,
        barrier: digit,
        label: `Differ ${digit}`,
        winRate: 0.9,
        expectedValue: 0.9 * mdPayout - 0.1,
        payoutMultiplier: mdPayout,
      });
    }

    // ── Even/Odd ──────────────────────────────────────────────────
    const eoPayout = PAYOUT_MULTIPLIER.even_odd;
    
    options.push({
      contract: 'even_odd',
      direction: 'even' as Direction,
      barrier: undefined,
      label: 'Even',
      winRate: 0.5,
      expectedValue: 0.5 * eoPayout - 0.5,
      payoutMultiplier: eoPayout,
    });

    options.push({
      contract: 'even_odd',
      direction: 'odd' as Direction,
      barrier: undefined,
      label: 'Odd',
      winRate: 0.5,
      expectedValue: 0.5 * eoPayout - 0.5,
      payoutMultiplier: eoPayout,
    });

    return options;
  }

  /**
   * Estimate win rate for Rise/Fall based on trend and volatility
   */
  private estimateRiseFallWinRate(market: MarketData): number {
    const trendScore = this.calculateTrendScore(market);
    const volatilityScore = this.calculateVolatilityScore(market);
    
    // Base win rate is 50% (random)
    // Trend adds up to 15% if strong
    // Volatility adds up to 5% if moderate
    const trendBonus = (trendScore - 50) / 50 * 0.15;
    const volBonus = volatilityScore > 40 && volatilityScore < 70 ? 0.05 : 0;
    
    return Math.min(0.85, Math.max(0.15, 0.5 + trendBonus + volBonus));
  }

  /**
   * Calculate score for a specific combination
   */
  private calculateCombinationScore(
    market: MarketData,
    option: ContractOption,
    riskTolerance: 'conservative' | 'moderate' | 'aggressive'
  ): number {
    const volatilityScore = this.calculateVolatilityScore(market);
    const trendScore = this.calculateTrendScore(market);
    const reversionScore = this.calculateReversionScore(market);
    const winRateScore = this.calculateWinRateScore(market.symbol, option.contract);
    const riskScore = this.calculateRiskScore(market);
    const expectedValueScore = this.calculateExpectedValueScore(option);
    
    // Weights
    const weights = {
      volatility: 0.15,
      trend: 0.15,
      reversion: 0.10,
      winRate: 0.15,
      risk: 0.10,
      expectedValue: 0.35, // Highest weight - EV is most important
    };

    // Risk tolerance adjustments
    let riskMultiplier = 1;
    if (riskTolerance === 'conservative') {
      riskMultiplier = 0.5;
      // Conservative: prefer lower risk, higher win rate
    } else if (riskTolerance === 'aggressive') {
      riskMultiplier = 1.5;
      // Aggressive: prefer higher EV, higher volatility
    }

    const totalScore =
      volatilityScore * weights.volatility +
      trendScore * weights.trend +
      reversionScore * weights.reversion +
      winRateScore * weights.winRate +
      riskScore * weights.risk * riskMultiplier +
      expectedValueScore * weights.expectedValue;

    return Math.min(100, Math.max(0, totalScore));
  }

  /**
   * Calculate Expected Value Score (0-100)
   * Higher EV = higher score
   */
  private calculateExpectedValueScore(option: ContractOption): number {
    // EV is typically between -0.5 and +1.5
    // Map to 0-100
    const normalized = (option.expectedValue + 0.5) / 2.0; // -0.5 → 0, 1.5 → 100
    return Math.min(100, Math.max(0, normalized * 100));
  }

  /**
   * Build the final decision object
   */
  private buildDecision(
    best: ContractOption & { market: MarketData; score: number },
    balance: number,
    confidence: number
  ): AIDecision {
    const isNegative = NEGATIVE_DIRECTIONS.includes(best.direction);

    return {
      symbol: best.market.symbol,
      contract: best.contract,
      direction: best.direction,
      barrier: best.barrier,
      confidence,
      score: best.score,
      expectedValue: best.expectedValue,
      winRate: best.winRate,
      reasoning: {
        market: VOLATILITIES.find(v => v.id === best.market.symbol)?.name || best.market.symbol,
        contract: best.contract.replace('_', ' ').toUpperCase(),
        direction: best.direction.toUpperCase(),
        barrier: best.barrier !== undefined ? best.barrier.toString() : 'N/A',
        volatility: best.market.volatility > 0.001 ? 'High' : best.market.volatility > 0.0005 ? 'Medium' : 'Low',
        trend: this.buildTrendReasoning(best.market),
        reversion: this.buildReversionReasoning(best.market),
        winRate: `${(best.winRate * 100).toFixed(0)}%`,
        risk: isNegative ? 'Higher risk (negative direction)' : 'Lower risk (positive direction)',
        expectedValue: `$${best.expectedValue.toFixed(2)} per $1 staked`,
      },
      suggestedStake: this.calculateSuggestedStake(balance, confidence),
      suggestedStopLoss: this.calculateSuggestedStopLoss(balance, confidence),
      suggestedTakeProfit: this.calculateSuggestedTakeProfit(balance, confidence),
      timestamp: Date.now(),
    };
  }

  private buildTrendReasoning(market: MarketData): string {
    const change = market.changePct || 0;
    if (change > 0.5) return `Strong upward (${change.toFixed(2)}%)`;
    if (change > 0.1) return `Upward (${change.toFixed(2)}%)`;
    if (change > -0.1) return 'Sideways';
    if (change > -0.5) return `Downward (${change.toFixed(2)}%)`;
    return `Strong downward (${change.toFixed(2)}%)`;
  }

  private buildReversionReasoning(market: MarketData): string {
    // Simplified: use price deviation from typical range
    const price = market.price;
    const vol = market.volatility;
    // Rough estimate: if price is > 2x volatility from mean, it may revert
    if (price > 10000 + vol * 1000) return 'Overbought (likely to revert down)';
    if (price < 10000 - vol * 1000) return 'Oversold (likely to revert up)';
    return 'In normal range';
  }

  // ── Score Calculators ────────────────────────────────────────────

  private calculateVolatilityScore(market: MarketData): number {
    const maxSigma = 0.002;
    const minSigma = 0.0002;
    const normalized = (market.volatility - minSigma) / (maxSigma - minSigma);
    return Math.min(100, Math.max(0, normalized * 100));
  }

  private calculateTrendScore(market: MarketData): number {
    const changePct = market.changePct || 0;
    const normalized = (changePct / 10) * 50 + 50;
    return Math.min(100, Math.max(0, normalized));
  }

  private calculateReversionScore(market: MarketData): number {
    const volatilityScore = this.calculateVolatilityScore(market);
    return 100 - volatilityScore * 0.5;
  }

  private calculateWinRateScore(symbol: VolatilityId, contract: ContractType): number {
    const symbolPerf = this.performance.symbolPerformance[symbol];
    const contractPerf = this.performance.contractPerformance[contract];
    
    const symbolTotal = symbolPerf.wins + symbolPerf.losses;
    const contractTotal = contractPerf.wins + contractPerf.losses;
    
    if (symbolTotal === 0 && contractTotal === 0) return 50;
    
    const symbolRate = symbolTotal > 0 ? (symbolPerf.wins / symbolTotal) : 0.5;
    const contractRate = contractTotal > 0 ? (contractPerf.wins / contractTotal) : 0.5;
    
    // Weight: 70% contract performance, 30% symbol performance
    return (contractRate * 0.7 + symbolRate * 0.3) * 100;
  }

  private calculateRiskScore(market: MarketData): number {
    const volatilityScore = this.calculateVolatilityScore(market);
    return 100 - volatilityScore * 0.7;
  }

  // ── Suggested Values ─────────────────────────────────────────────

  private calculateSuggestedStake(balance: number, confidence: number): number {
    const riskPercent = 0.01 + (confidence / 100) * 0.02;
    let stake = balance * riskPercent;
    stake = Math.round(stake * 2) / 2;
    return Math.min(50, Math.max(2, stake));
  }

  private calculateSuggestedStopLoss(balance: number, confidence: number): number {
    const base = balance * 0.05;
    const adjusted = base * (1 + (100 - confidence) / 100);
    return Math.round(Math.min(200, Math.max(10, adjusted)));
  }

  private calculateSuggestedTakeProfit(balance: number, confidence: number): number {
    const base = balance * 0.05;
    const adjusted = base * (1 + confidence / 100);
    return Math.round(Math.min(200, Math.max(10, adjusted)));
  }

  // ── Performance Tracking ────────────────────────────────────────

  public recordTradeOutcome(
    symbol: VolatilityId,
    contract: ContractType,
    direction: Direction,
    barrier: number | undefined,
    outcome: 'win' | 'loss',
    pnl: number
  ) {
    this.tradeHistory.push({ symbol, contract, direction, barrier, outcome, pnl });
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.shift();
    }
    this.updatePerformanceFromHistory();
  }

  private updatePerformanceFromHistory() {
    const performance: AIPerformance = {
      totalDecisions: this.tradeHistory.length,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      symbolPerformance: {
        v100_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v50_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v25_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
      contractPerformance: {
        rise_fall: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        over_under: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        match_differ: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        even_odd: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
    };

    for (const trade of this.tradeHistory) {
      performance.totalDecisions++;
      if (trade.outcome === 'win') {
        performance.wins++;
        performance.symbolPerformance[trade.symbol].wins++;
        performance.contractPerformance[trade.contract].wins++;
      } else {
        performance.losses++;
        performance.symbolPerformance[trade.symbol].losses++;
        performance.contractPerformance[trade.contract].losses++;
      }
      performance.totalPnl += trade.pnl;
      performance.symbolPerformance[trade.symbol].pnl += trade.pnl;
      performance.symbolPerformance[trade.symbol].trades++;
      performance.contractPerformance[trade.contract].pnl += trade.pnl;
      performance.contractPerformance[trade.contract].trades++;
    }

    this.performance = performance;
  }

  // ── Getters ──────────────────────────────────────────────────────

  public getPerformance(): AIPerformance {
    return { ...this.performance };
  }

  public getLastDecision(): AIDecision | null {
    return this.lastDecision;
  }

  public getDecisionHistory(count = 20): AIDecision[] {
    return this.decisions.slice(-count);
  }

  public reset() {
    this.tradeHistory = [];
    this.decisions = [];
    this.lastDecision = null;
    this.performance = {
      totalDecisions: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      symbolPerformance: {
        v100_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v50_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        v25_1s: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
      contractPerformance: {
        rise_fall: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        over_under: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        match_differ: { wins: 0, losses: 0, pnl: 0, trades: 0 },
        even_odd: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      },
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let aiEngineInstance: AIEngine | null = null;

export function getAIEngine(initialHistory?: TradeHistory[]): AIEngine {
  if (!aiEngineInstance) {
    aiEngineInstance = new AIEngine(initialHistory);
  }
  return aiEngineInstance;
}

export function resetAIEngine() {
  aiEngineInstance = null;
}