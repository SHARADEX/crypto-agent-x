// Benchmark cases — research summarization (Phase-2 §7 / P2-4 / P1-7).
//
// Each case provides a short text and asks for a 1-sentence summary. The
// grader checks that:
//   1. The response is exactly 1 sentence (deterministic — count `.!?`).
//   2. The response mentions a key term from the source (regex).
// NO LLM judging — pure string operations.

import type { BenchmarkCase } from "../types";
import { countSentences } from "../grader";

export const researchSummarizationCases: BenchmarkCase[] = [
  {
    id: "research-summary-blockchain-v1",
    category: "research_summarization",
    prompt:
      `Read the following text and write a ONE-SENTENCE summary of it.\n\n` +
      `"""A blockchain is a distributed, immutable ledger that records\n` +
      `transactions across a peer-to-peer network of computers. Each block\n` +
      `contains a cryptographic hash of the previous block, linking them\n` +
      `together in a chain. Once a block is added, its data cannot be altered\n` +
      `without altering every subsequent block — which requires consensus from\n` +
      `the majority of the network. Blockchains underpin cryptocurrencies like\n` +
      `Bitcoin and Ethereum, and are increasingly used for supply-chain\n` +
      `tracking, identity management, and smart contracts."""\n\n` +
      `Constraints:\n` +
      `- Exactly ONE sentence (ending with a period).\n` +
      `- Must mention the word "ledger" or "distributed".\n` +
      `- No bullet points, no lists.\n\n` +
      `Respond with only the summary.`,
    expected: { keywords: ["ledger", "distributed"], sentences: 1 },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) => {
      const exp = expected as { keywords: string[]; sentences: number };
      const lower = response.toLowerCase();
      const hasKeyword = exp.keywords.some((k) =>
        new RegExp(`\\b${k.toLowerCase()}\\b`).test(lower)
      );
      const sentenceCount = countSentences(response);
      const ok = hasKeyword && sentenceCount === exp.sentences;
      return {
        score: ok ? 1 : hasKeyword ? 0.5 : 0,
        passed: ok,
        details: ok
          ? `1 sentence, mentions keyword`
          : `keyword=${hasKeyword}, sentences=${sentenceCount} (expected ${exp.sentences})`,
      };
    },
  },
  {
    id: "research-summary-photosynthesis-v1",
    category: "research_summarization",
    prompt:
      `Read the following text and write a ONE-SENTENCE summary of it.\n\n` +
      `"""Photosynthesis is the process by which green plants, algae, and some\n` +
      `bacteria convert light energy into chemical energy stored in glucose\n` +
      `molecules. The reaction takes place primarily in the chloroplasts, which\n` +
      `contain the green pigment chlorophyll that absorbs light. The overall\n` +
      `reaction uses carbon dioxide and water as inputs, and produces glucose\n` +
      `and oxygen as outputs. Photosynthesis is responsible for the oxygen in\n` +
      `Earth's atmosphere and is the foundation of most food chains."""\n\n` +
      `Constraints:\n` +
      `- Exactly ONE sentence (ending with a period).\n` +
      `- Must mention the word "energy" or "light".\n` +
      `- No bullet points, no lists.\n\n` +
      `Respond with only the summary.`,
    expected: { keywords: ["energy", "light"], sentences: 1 },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) => {
      const exp = expected as { keywords: string[]; sentences: number };
      const lower = response.toLowerCase();
      const hasKeyword = exp.keywords.some((k) =>
        new RegExp(`\\b${k.toLowerCase()}\\b`).test(lower)
      );
      const sentenceCount = countSentences(response);
      const ok = hasKeyword && sentenceCount === exp.sentences;
      return {
        score: ok ? 1 : hasKeyword ? 0.5 : 0,
        passed: ok,
        details: ok
          ? `1 sentence, mentions keyword`
          : `keyword=${hasKeyword}, sentences=${sentenceCount} (expected ${exp.sentences})`,
      };
    },
  },
  {
    id: "research-summary-defi-v1",
    category: "research_summarization",
    prompt:
      `Read the following text and write a ONE-SENTENCE summary of it.\n\n` +
      `"""Decentralized finance (DeFi) refers to financial services built on\n` +
      `blockchain networks that operate without traditional intermediaries like\n` +
      `banks or brokerages. Instead, DeFi protocols use smart contracts to\n` +
      `automate lending, borrowing, trading, and yield farming. Users interact\n` +
      `with these protocols directly through their crypto wallets, retaining\n` +
      `custody of their own assets. While DeFi promises greater accessibility\n` +
      `and transparency, it also introduces significant risks including smart\n` +
      `contract bugs, price volatility, and regulatory uncertainty."""\n\n` +
      `Constraints:\n` +
      `- Exactly ONE sentence (ending with a period).\n` +
      `- Must mention the word "smart contract" or "blockchain".\n` +
      `- No bullet points, no lists.\n\n` +
      `Respond with only the summary.`,
    expected: { keywords: ["smart contract", "blockchain"], sentences: 1 },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) => {
      const exp = expected as { keywords: string[]; sentences: number };
      const lower = response.toLowerCase();
      const hasKeyword = exp.keywords.some((k) =>
        lower.includes(k.toLowerCase())
      );
      const sentenceCount = countSentences(response);
      const ok = hasKeyword && sentenceCount === exp.sentences;
      return {
        score: ok ? 1 : hasKeyword ? 0.5 : 0,
        passed: ok,
        details: ok
          ? `1 sentence, mentions keyword`
          : `keyword=${hasKeyword}, sentences=${sentenceCount} (expected ${exp.sentences})`,
      };
    },
  },
];
