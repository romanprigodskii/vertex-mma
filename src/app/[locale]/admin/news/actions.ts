"use server";

import { moderateNewsItem, type ModerationResult } from "@/lib/news-moderation";

export async function approveNewsAction(input: {
  id: string;
}): Promise<ModerationResult> {
  return moderateNewsItem(input.id, "approve");
}

export async function rejectNewsAction(input: {
  id: string;
}): Promise<ModerationResult> {
  return moderateNewsItem(input.id, "reject");
}
