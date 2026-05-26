"use server";

import {
  addNewsComment,
  softDeleteComment,
  type AddCommentResult,
} from "@/lib/news-comments";

export async function postCommentAction(input: {
  newsItemId: string;
  parentId: string | null;
  body: string;
}): Promise<AddCommentResult> {
  return addNewsComment(input);
}

export async function deleteCommentAction(input: { commentId: string }) {
  return softDeleteComment(input.commentId);
}
