import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const isTest = process.env.NODE_ENV === 'test';

// Lazy PrismaClient creation: defers construction to first property access
// so that scripts which set process.env.DATABASE_URL AFTER the module is
// imported get the correct URL. Bun auto-loads .env at import time which
// can override command-line env vars — by deferring, we ensure the latest
// process.env.DATABASE_URL is used.
let _prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;

  const databaseUrl = process.env.DATABASE_URL;
  _prisma = new PrismaClient({
    log: isTest ? ['error'] : ['query'],
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = _prisma;
  }

  return _prisma;
}

// Proxy that forwards all property access to the lazily-created PrismaClient.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const prisma = getPrisma();
    const value = (prisma as never as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(prisma) : value;
  },
}) as PrismaClient;
