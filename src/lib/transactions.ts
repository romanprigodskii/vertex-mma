import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { transaction } from "@/lib/db/schema/users";

export type TransactionRow = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in user's coin ledger, newest first. */
export async function listTransactionsForUser(
  userProfileId: string,
  limit = 100,
): Promise<TransactionRow[]> {
  if (!UUID_RE.test(userProfileId)) return [];
  const rows = await db
    .select({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      balanceAfter: transaction.balanceAfter,
      description: transaction.description,
      createdAt: transaction.createdAt,
    })
    .from(transaction)
    .where(eq(transaction.userId, userProfileId))
    .orderBy(desc(transaction.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    balanceAfter: r.balanceAfter,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
  }));
}
