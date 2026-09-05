// Wallet configuration (spec §12).
//
// These are the PUBLIC READ-ONLY wallet addresses provided by the operator.
// The agent NEVER stores private keys, seed phrases, or recovery phrases.
// All wallet interactions are read-only balance/transaction monitoring via
// public blockchain explorer APIs.

import type { WalletConfig } from "@/lib/agent/types";

export const WALLETS: WalletConfig[] = [
  {
    label: "Ronin Wallet",
    chain: "ronin",
    address: "0xAa4E76e5Be5334c0f2Fe0716C42B2FC61D4c150B",
    explorer: "https://app.roninchain.com",
  },
  {
    label: "MetaMask (EVM) Wallet",
    chain: "ethereum",
    address: "0xd6DFE6b54bF3dBC919Fde57009452fe6bbb0D997",
    explorer: "https://etherscan.io",
  },
  {
    label: "Bitcoin Wallet",
    chain: "bitcoin",
    address: "bc1qh3areygq598ntxht0yp5yv87ej7g6aqvw8fl4z",
    explorer: "https://blockchain.info",
  },
  {
    label: "Solana Wallet",
    chain: "solana",
    address: "2emXSLoziaB5wdC8y48ovbu41agh9PzR5ro8o7kRDUvM",
    explorer: "https://solscan.io",
  },
  {
    label: "Tron Wallet",
    chain: "tron",
    address: "TJxkyJW57Tb8qmvvv5rCh3L2FYssRvWFEv",
    explorer: "https://tronscan.org",
  },
];

// Approximate USD reference prices used for display only. These are
// intentionally conservative and only used as a fallback when a live price
// cannot be fetched. They are NOT used for accounting — verified earnings
// store the USD value at the time of payment.
export const NATIVE_PRICE_FALLBACK_USD: Record<string, number> = {
  ETH: 3200,
  BTC: 62000,
  SOL: 145,
  TRX: 0.13,
  RON: 1.6,
  MATIC: 0.55,
  BNB: 580,
};

export const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  ethereum: "ETH",
  bitcoin: "BTC",
  solana: "SOL",
  tron: "TRX",
  ronin: "RON",
  polygon: "MATIC",
  bsc: "BNB",
  arbitrum: "ETH",
  optimism: "ETH",
};
